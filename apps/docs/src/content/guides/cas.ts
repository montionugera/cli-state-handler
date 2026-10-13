import { CORE, DART, CS, type Guide } from "./types.js";

export const cas: Guide = {
  id: "cas",
  label: "CAS Package Cache",
  ts: {
    title: "Content-Addressable Storage & LRU Pruning (TypeScript)",
    lang: "typescript",
    available: true,
    sources: [`${CORE}/storage/cas-store.ts`, `${CORE}/storage/cas-lru.ts`],
    code: `// Checked against: packages/core/src/storage/cas-store.ts (CasStore, put, get, prune)
import { CasStore } from "@montionugera/ucsa-core";

const cas = new CasStore({
  baseDir: "./cas",
  sqliteAdapter: sqlite,        // the LRU index lives here
  maxSizeBytes: 50 * 1024 * 1024, // 0 or undefined = unbounded
});
await cas.init();

const { hash, size, path } = await cas.put(new TextEncoder().encode("payload"));
const bytes = await cas.get(hash); // Buffer | null
console.log(hash, size, path, bytes?.length);`,
    notes: [
      "Blobs are addressed by SHA-256, so storing the same bytes twice keeps one blob.",
      "put() prunes when the total size is over maxSizeBytes: it deletes least-recently-used blobs until the total is at or below 70% of the budget (prune(targetRatio = 0.7)).",
      "The blob you just stored can be evicted by its own prune, for example when it alone is larger than the target.",
      "There is no reference counting and no pinning: anything that holds a hash can find the blob gone.",
    ],
  },
  dart: {
    title: "Content-Addressable Storage & LRU Pruning (Dart / Flutter)",
    lang: "dart",
    available: true,
    sources: [`${DART}/cas_store.dart`],
    code: `// Checked against: packages/ucsa_dart/lib/src/cas_store.dart (CasStore, put, get, prune)
import 'dart:convert';
import 'package:ucsa_dart/ucsa_dart.dart';

final cas = CasStore(
  baseDir: 'cas',
  sqliteAdapter: sqlite,
  maxSizeBytes: 50 * 1024 * 1024,
);
await cas.init();

final put = await cas.put(utf8.encode('payload')); // CasPutResult(hash, size, path)
final bytes = await cas.get(put.hash);             // List<int>?
final pruned = await cas.prune();                  // CasPruneResult(prunedCount, bytesFreed)`,
    notes: [
      "Same model as TypeScript: SHA-256 addressing, LRU prune to a 70% target (prune({targetRatio})), no reference counting or pinning. A manual prune() here evicts whenever the total is above 70% of maxSizeBytes; TypeScript prune() does nothing until the total exceeds maxSizeBytes.",
      "put takes List<int> and an optional expectedHash named argument.",
    ],
  },
  csharp: {
    title: "Content-Addressable Storage & LRU Pruning (C# Unity)",
    lang: "csharp",
    available: true,
    sources: [`${CS}/Storage/CasStore.cs`],
    code: `// Checked against: Runtime/Storage/CasStore.cs (CasStore, PutAsync, GetAsync, PruneAsync)
using Ucsa.Storage;

var cas = new CasStore(
    Application.persistentDataPath + "/cas",
    sqlite,
    maxSizeBytes: 50L * 1024 * 1024);
await cas.InitAsync();

CasPutResult put = await cas.PutAsync(System.Text.Encoding.UTF8.GetBytes("payload"));
byte[]? bytes = await cas.GetAsync(put.Hash);
CasPruneResult pruned = await cas.PruneAsync(); // targetRatio defaults to 0.7`,
    notes: [
      "Same model as Dart; PutAsync prunes when the total is over maxSizeBytes. A manual PruneAsync evicts whenever the total is above 70% of maxSizeBytes; TypeScript prune() does nothing until the total exceeds maxSizeBytes.",
      "No reference counting or pinning.",
    ],
  },
  godot: {
    title: "Content-Addressable Storage & LRU Pruning (C# Godot)",
    lang: "csharp",
    available: true,
    sources: [`${CS}/Storage/CasStore.cs`],
    code: `// Checked against: com.ucsa.core Runtime/Storage/CasStore.cs (CasStore, PutAsync, GetAsync, PruneAsync)
using System.IO;
using Godot;
using Ucsa.Storage;

var cas = new CasStore(
    Path.Combine(ProjectSettings.GlobalizePath("user://"), "cas"),
    sqlite,
    maxSizeBytes: 50L * 1024 * 1024);
await cas.InitAsync();

CasPutResult put = await cas.PutAsync(System.Text.Encoding.UTF8.GetBytes("payload"));
byte[]? bytes = await cas.GetAsync(put.Hash);
CasPruneResult pruned = await cas.PruneAsync(); // targetRatio defaults to 0.7`,
    notes: [
      "Same class as the Unity column, from the shared core; PutAsync prunes when the total is over maxSizeBytes. A manual PruneAsync evicts whenever the total is above 70% of maxSizeBytes.",
      "No reference counting or pinning. The Godot TextureCache (packages/ucsa_godot/addons/ucsa/TextureCache.cs) stores downloaded images through this store.",
    ],
  },
};
