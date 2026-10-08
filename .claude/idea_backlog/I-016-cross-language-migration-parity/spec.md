---
title: "cross-language-migration-parity"
id: I-016
status: idea
---

# cross-language-migration-parity

## Acceptance criteria

- [ ] Dart `packages/ucsa_dart` implements `MigrationRunner` applying baseline migration v1 to SQLite using `package:sqlite3`.
- [ ] Dart `SqliteAdapter.initSchema()` executes migration runner and exposes `getSchemaVersion()`.
- [ ] C# Unity `packages/com.ucsa.unity` implements `MigrationRunner` applying baseline migration v1 to SQLite using `Microsoft.Data.Sqlite`.
- [ ] C# `UnitySqliteAdapter.InitSchema()` executes migration runner and exposes `GetSchemaVersion()`.
- [ ] Cross-language test fixtures verify round-robin compatibility: a database file initialized/migrated by TypeScript is opened by Dart and C# without error, reads cached queries, and confirms `user_version = 1`.
- [ ] Comprehensive unit tests added in `packages/ucsa_dart/test/migration_test.dart` and `packages/com.ucsa.unity/Tests/Runtime/MigrationTests.cs`.
