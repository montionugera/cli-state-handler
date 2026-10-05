import 'dart:io';
import 'dart:math';
import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;
import 'sqlite_adapter.dart';

/// Thrown when a CAS operation fails an integrity checksum verification.
class IntegrityException implements Exception {
  final String message;
  final String? expected;
  final String actual;

  IntegrityException(
    this.message, {
    this.expected,
    required this.actual,
  });

  @override
  String toString() =>
      'IntegrityException: $message (expected: $expected, actual: $actual)';
}

/// Metadata result returned by [CasStore.put].
class CasPutResult {
  final String hash;
  final int size;
  final String path;

  const CasPutResult({
    required this.hash,
    required this.size,
    required this.path,
  });

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CasPutResult &&
          runtimeType == other.runtimeType &&
          hash == other.hash &&
          size == other.size &&
          path == other.path;

  @override
  int get hashCode => Object.hash(hash, size, path);

  @override
  String toString() => 'CasPutResult(hash: $hash, size: $size, path: $path)';
}

/// Eviction summary returned by [CasStore.prune].
class CasPruneResult {
  final int prunedCount;
  final int bytesFreed;

  const CasPruneResult({
    required this.prunedCount,
    required this.bytesFreed,
  });

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CasPruneResult &&
          runtimeType == other.runtimeType &&
          prunedCount == other.prunedCount &&
          bytesFreed == other.bytesFreed;

  @override
  int get hashCode => Object.hash(prunedCount, bytesFreed);

  @override
  String toString() =>
      'CasPruneResult(prunedCount: $prunedCount, bytesFreed: $bytesFreed)';
}

/// Content-Addressable Storage (CAS) engine.
///
/// Features:
/// - SHA-256 content-addressing
/// - Atomic promotion via temporary file rename (.tmp_<id> -> objects/<prefix>/<hash>)
/// - Integrity check on put when expectedHash is supplied
/// - Access tracking in SQLite (ucsa_cas_objects)
/// - LRU pruning when maxSizeBytes quota is exceeded
class CasStore {
  final String baseDir;
  final SqliteAdapter? sqliteAdapter;
  final int? maxSizeBytes;
  final Random _random;

  bool _initialized = false;

  CasStore({
    required this.baseDir,
    this.sqliteAdapter,
    this.maxSizeBytes,
    Random? random,
  }) : _random = random ?? Random();

  /// Directory holding partitioned CAS objects: <baseDir>/objects/<prefix>/<hash>
  String get objectsDir => p.join(baseDir, 'objects');

  /// Directory holding temporary files before atomic promotion: <baseDir>/tmp
  String get tmpDir => p.join(baseDir, 'tmp');

  /// Initializes directories and SQLite tables if required.
  Future<void> init() async {
    if (_initialized) return;

    await Directory(objectsDir).create(recursive: true);
    await Directory(tmpDir).create(recursive: true);

    if (sqliteAdapter != null) {
      sqliteAdapter!.initSchema();
    }

    _initialized = true;
  }

  /// Returns the deterministic file system path for a given SHA-256 hash.
  String getPath(String hash) {
    final prefix = hash.length >= 2 ? hash.substring(0, 2) : hash;
    return p.join(objectsDir, prefix, hash);
  }

  /// Writes data atomically to the CAS store and verifies SHA-256 checksum integrity.
  ///
  /// 1. Data is written to a temporary file in `<baseDir>/tmp/.tmp_<uuid>`.
  /// 2. SHA-256 digest is computed from bytes.
  /// 3. If [expectedHash] is provided and does not match, the temporary file is deleted
  ///    and an [IntegrityException] is thrown.
  /// 4. The temporary file is atomically renamed to `<baseDir>/objects/<prefix>/<hash>`.
  /// 5. If [sqliteAdapter] is attached, records size and timestamp in `ucsa_cas_objects`.
  /// 6. If storage exceeds [maxSizeBytes], triggers LRU eviction to [targetRatio].
  Future<CasPutResult> put(
    List<int> bytes, {
    String? expectedHash,
  }) async {
    await init();

    final id =
        '${DateTime.now().microsecondsSinceEpoch}_${_random.nextInt(1000000)}';
    final tempFileName = '.tmp_$id';
    final tempFilePath = p.join(tmpDir, tempFileName);
    final tempFile = File(tempFilePath);

    await tempFile.writeAsBytes(bytes, flush: true);

    final actualHash = sha256.convert(bytes).toString();

    if (expectedHash != null &&
        expectedHash.toLowerCase() != actualHash.toLowerCase()) {
      if (await tempFile.exists()) {
        try {
          await tempFile.delete();
        } catch (_) {}
      }
      throw IntegrityException(
        'Checksum mismatch: expected $expectedHash, computed $actualHash',
        expected: expectedHash,
        actual: actualHash,
      );
    }

    final prefix = actualHash.substring(0, 2);
    final targetDir = p.join(objectsDir, prefix);
    await Directory(targetDir).create(recursive: true);

    final targetPath = p.join(targetDir, actualHash);

    try {
      await tempFile.rename(targetPath);
    } catch (e) {
      if (await tempFile.exists()) {
        try {
          await tempFile.delete();
        } catch (_) {}
      }
      rethrow;
    }

    if (sqliteAdapter != null) {
      sqliteAdapter!.upsertCasObject(
        actualHash,
        bytes.length,
        lastAccessedAt: DateTime.now().millisecondsSinceEpoch,
      );

      if (maxSizeBytes != null && maxSizeBytes! > 0) {
        final totalSize = sqliteAdapter!.getTotalCasSize();
        if (totalSize > maxSizeBytes!) {
          await prune();
        }
      }
    }

    return CasPutResult(
      hash: actualHash,
      size: bytes.length,
      path: targetPath,
    );
  }

  /// Retrieves the raw bytes for an object by its SHA-256 hash.
  /// On cache hit, touches file mtime and updates access time in SQLite.
  /// Returns `null` if the object does not exist.
  Future<List<int>?> get(String hash) async {
    final filePath = getPath(hash);
    final file = File(filePath);

    if (!await file.exists()) {
      return null;
    }

    final bytes = await file.readAsBytes();

    // Touch file modification time
    try {
      await file.setLastModified(DateTime.now());
    } catch (_) {}

    // Update SQLite last_accessed_at
    if (sqliteAdapter != null) {
      final now = DateTime.now().millisecondsSinceEpoch;
      final updated =
          sqliteAdapter!.updateCasAccessTime(hash, lastAccessedAt: now);
      if (!updated) {
        sqliteAdapter!.upsertCasObject(hash, bytes.length, lastAccessedAt: now);
      }
    }

    return bytes;
  }

  /// Checks whether an object exists in the CAS store on disk.
  Future<bool> has(String hash) async {
    return File(getPath(hash)).exists();
  }

  /// Deletes an object by its SHA-256 hash from both disk and SQLite index.
  /// Returns `true` if deleted, `false` if it did not exist.
  Future<bool> delete(String hash) async {
    final filePath = getPath(hash);
    final file = File(filePath);

    var diskDeleted = false;
    if (await file.exists()) {
      try {
        await file.delete();
        diskDeleted = true;
      } catch (_) {}
    }

    var dbDeleted = false;
    if (sqliteAdapter != null) {
      dbDeleted = sqliteAdapter!.deleteCasObject(hash);
    }

    return diskDeleted || dbDeleted;
  }

  /// Returns the total byte size of all tracked CAS objects in SQLite.
  Future<int> getTotalSize() async {
    if (sqliteAdapter == null) return 0;
    return sqliteAdapter!.getTotalCasSize();
  }

  /// Prunes least recently accessed objects when total storage exceeds limit.
  ///
  /// Deletes oldest unaccessed objects until total size <= `maxSizeBytes * targetRatio`.
  Future<CasPruneResult> prune({double targetRatio = 0.7}) async {
    if (sqliteAdapter == null) {
      return const CasPruneResult(prunedCount: 0, bytesFreed: 0);
    }

    final limit = maxSizeBytes;
    if (limit == null || limit <= 0) {
      return const CasPruneResult(prunedCount: 0, bytesFreed: 0);
    }

    var currentSize = sqliteAdapter!.getTotalCasSize();
    final targetSize = (limit * targetRatio).floor();
    if (currentSize <= targetSize) {
      return const CasPruneResult(prunedCount: 0, bytesFreed: 0);
    }
    final candidates = sqliteAdapter!.getLruCasObjects();

    var prunedCount = 0;
    var bytesFreed = 0;

    for (final candidate in candidates) {
      if (currentSize <= targetSize) {
        break;
      }

      final hash = candidate['hash'] as String;
      final size = candidate['size'] as int;
      final filePath = getPath(hash);
      final file = File(filePath);

      if (await file.exists()) {
        try {
          await file.delete();
        } catch (_) {}
      }

      sqliteAdapter!.deleteCasObject(hash);
      prunedCount++;
      bytesFreed += size;
      currentSize -= size;
    }

    return CasPruneResult(prunedCount: prunedCount, bytesFreed: bytesFreed);
  }
}
