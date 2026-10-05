import 'package:test/test.dart';
import 'package:ucsa_dart/ucsa_dart.dart';

void main() {
  group('QueryKey & Deterministic Hashing', () {
    test('hashQueryKey normalizes map keys irrespective of insertion order',
        () {
      final key1 = [
        'users',
        {
          'role': 'admin',
          'page': 1,
          'filter': {'active': true, 'tier': 'gold'}
        }
      ];
      final key2 = [
        'users',
        {
          'filter': {'tier': 'gold', 'active': true},
          'page': 1,
          'role': 'admin'
        }
      ];

      expect(hashQueryKey(key1), equals(hashQueryKey(key2)));
      expect(
        hashQueryKey(key1),
        '["users",{"filter":{"active":true,"tier":"gold"},"page":1,"role":"admin"}]',
      );
    });

    test('hashQueryKey handles primitives, lists, and nulls correctly', () {
      final key = [
        'todos',
        null,
        42,
        true,
        ['a', 'b']
      ];
      expect(hashQueryKey(key), '["todos",null,42,true,["a","b"]]');
    });

    test('computeSha256 produces valid 64-character hex string', () {
      final hash = computeSha256('hello world');
      expect(hash,
          'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    });
  });

  group('CacheEntry & OutboxMutation Models', () {
    test('CacheEntry stale and expired checks respect timestamps', () {
      final now = 1000000;
      final entry = CacheEntry<Map<String, dynamic>>(
        queryHash: '["test"]',
        queryKey: const ['test'],
        dataPayload: {'value': 123},
        createdAt: now - 5000,
        staleAt: now - 1000,
        expiresAt: now + 5000,
      );

      expect(entry.isStale(now), isTrue);
      expect(entry.isExpired(now), isFalse);
      expect(entry.isExpired(now + 6000), isTrue);
    });

    test('CacheEntry serialization and deserialization roundtrip', () {
      final entry = CacheEntry<Map<String, dynamic>>(
        queryHash: 'q1',
        queryKey: const ['items', 1],
        dataPayload: {'name': 'Widget'},
        etag: 'w/1234',
        createdAt: 100,
        staleAt: 200,
        expiresAt: 300,
      );

      final json = entry.toJson();
      final roundtrip = CacheEntry<Map<String, dynamic>>.fromJson(json);

      expect(roundtrip.queryHash, entry.queryHash);
      expect(roundtrip.queryKey, entry.queryKey);
      expect(roundtrip.dataPayload, entry.dataPayload);
      expect(roundtrip.etag, entry.etag);
      expect(roundtrip.createdAt, entry.createdAt);
      expect(roundtrip.staleAt, entry.staleAt);
      expect(roundtrip.expiresAt, entry.expiresAt);
      expect(roundtrip, equals(entry));
    });

    test('OutboxMutation serialization roundtrip with conflict policy', () {
      final mutation = OutboxMutation<Map<String, dynamic>>(
        mutationId: 'm-123',
        endpoint: '/api/v1/update',
        method: 'POST',
        headers: {'Authorization': 'Bearer test-token'},
        payload: {'score': 99},
        status: OutboxMutationStatus.pending,
        retryCount: 2,
        createdAt: 1000,
        lastAttemptAt: 1050,
        error: 'Network unreachable',
        forced: true,
        conflictPolicy: ConflictPolicy.serverWins,
      );

      final json = mutation.toJson();
      final parsed = OutboxMutation<Map<String, dynamic>>.fromJson(json);

      expect(parsed.mutationId, 'm-123');
      expect(parsed.endpoint, '/api/v1/update');
      expect(parsed.method, 'POST');
      expect(parsed.headers, {'Authorization': 'Bearer test-token'});
      expect(parsed.payload, {'score': 99});
      expect(parsed.status, OutboxMutationStatus.pending);
      expect(parsed.retryCount, 2);
      expect(parsed.createdAt, 1000);
      expect(parsed.lastAttemptAt, 1050);
      expect(parsed.error, 'Network unreachable');
      expect(parsed.forced, isTrue);
      expect(parsed.conflictPolicy, ConflictPolicy.serverWins);
      expect(parsed.isPending, isTrue);
    });
  });

  group('LifecycleFSM Transitions & Sealed States', () {
    test('initial state is idle with IdleState sealed instance', () {
      final fsm = LifecycleFSM<String, String>();

      expect(fsm.state, QueryStatus.idle);
      expect(fsm.isIdle, isTrue);
      expect(fsm.isLoading, isFalse);
      expect(fsm.retryCount, 0);
      expect(fsm.data, isNull);
      expect(fsm.error, isNull);
      expect(fsm.fsmState, isA<IdleState<String, String>>());
    });

    test('transitions: idle -> loading -> success', () {
      final fsm = LifecycleFSM<String, String>();

      final status1 = fsm.startLoading();
      expect(status1, QueryStatus.loading);
      expect(fsm.isLoading, isTrue);
      expect(fsm.fsmState, isA<LoadingState<String, String>>());

      final status2 = fsm.recordSuccess('hello world');
      expect(status2, QueryStatus.success);
      expect(fsm.isSuccess, isTrue);
      expect(fsm.data, 'hello world');
      expect(fsm.error, isNull);
      expect(fsm.retryCount, 0);
      expect(fsm.fsmState, isA<SuccessState<String, String>>());
      expect(
          (fsm.fsmState as SuccessState<String, String>).data, 'hello world');
    });

    test('transitions: idle -> loading -> retrying up to maxRetries then error',
        () {
      final fsm = LifecycleFSM<String, String>(maxRetries: 3);

      fsm.startLoading();

      // Attempt 1 -> retrying (retryCount: 1)
      var status = fsm.recordError('err1');
      expect(status, QueryStatus.retrying);
      expect(fsm.retryCount, 1);
      expect(fsm.isRetrying, isTrue);
      expect(fsm.fsmState, isA<RetryingState<String, String>>());
      final r1 = fsm.fsmState as RetryingState<String, String>;
      expect(r1.attempt, 1);
      expect(r1.error, 'err1');
      expect(r1.delayMs, greaterThanOrEqualTo(0));

      // Attempt 2 -> retrying (retryCount: 2)
      status = fsm.recordError('err2');
      expect(status, QueryStatus.retrying);
      expect(fsm.retryCount, 2);

      // Attempt 3 -> retrying (retryCount: 3)
      status = fsm.recordError('err3');
      expect(status, QueryStatus.retrying);
      expect(fsm.retryCount, 3);

      // Attempt 4 -> exceeds maxRetries (3), transitions to error
      status = fsm.recordError('err4');
      expect(status, QueryStatus.error);
      expect(fsm.isError, isTrue);
      expect(fsm.retryCount, 3);
      expect(fsm.fsmState, isA<ErrorState<String, String>>());
      final errState = fsm.fsmState as ErrorState<String, String>;
      expect(errState.error, 'err4');
      expect(errState.attempt, 3);
    });

    test('success while retrying resets retryCount to 0', () {
      final fsm = LifecycleFSM<int, String>(maxRetries: 4);

      fsm.startLoading();
      fsm.recordError('temporary fail');
      expect(fsm.retryCount, 1);
      expect(fsm.isRetrying, isTrue);

      fsm.recordSuccess(42);
      expect(fsm.state, QueryStatus.success);
      expect(fsm.retryCount, 0);
      expect(fsm.data, 42);
      expect(fsm.error, isNull);
    });

    test('reset restores initial idle state', () {
      final fsm = LifecycleFSM<String, String>();
      fsm.startLoading();
      fsm.recordSuccess('cached');

      fsm.reset();
      expect(fsm.state, QueryStatus.idle);
      expect(fsm.isIdle, isTrue);
      expect(fsm.retryCount, 0);
      expect(fsm.data, isNull);
      expect(fsm.error, isNull);
      expect(fsm.fsmState, isA<IdleState<String, String>>());
    });

    test('exhaustive switch on sealed FsmState', () {
      final fsm = LifecycleFSM<String, String>();
      fsm.recordSuccess('data');

      final label = switch (fsm.fsmState) {
        IdleState() => 'idle',
        LoadingState() => 'loading',
        RetryingState(:final attempt) => 'retrying-$attempt',
        SuccessState(:final data) => 'success-$data',
        ErrorState(:final error) => 'error-$error',
      };

      expect(label, 'success-data');
    });
  });

  group('Full Jitter Exponential Backoff Calculation', () {
    test(
        'calculated delay stays within [0, min(maxDelay, baseDelay * 2^attempt)]',
        () {
      final fsm = LifecycleFSM<void, void>(
        baseDelayMs: 500,
        maxDelayMs: 30000,
      );

      // Attempt 0: max = 500 * 1 = 500
      for (var i = 0; i < 50; i++) {
        final delay = fsm.calculateBackoffDelay(0);
        expect(delay, greaterThanOrEqualTo(0));
        expect(delay, lessThanOrEqualTo(500));
      }

      // Attempt 1: max = 500 * 2 = 1000
      for (var i = 0; i < 50; i++) {
        final delay = fsm.calculateBackoffDelay(1);
        expect(delay, greaterThanOrEqualTo(0));
        expect(delay, lessThanOrEqualTo(1000));
      }

      // Attempt 2: max = 500 * 4 = 2000
      for (var i = 0; i < 50; i++) {
        final delay = fsm.calculateBackoffDelay(2);
        expect(delay, greaterThanOrEqualTo(0));
        expect(delay, lessThanOrEqualTo(2000));
      }

      // Attempt 10: base * 1024 = 512,000 capped at 30,000
      for (var i = 0; i < 50; i++) {
        final delay = fsm.calculateBackoffDelay(10);
        expect(delay, greaterThanOrEqualTo(0));
        expect(delay, lessThanOrEqualTo(30000));
      }

      // Extreme attempt (e.g. 50): must not overflow int64/int32
      final extremeDelay = fsm.calculateBackoffDelay(50);
      expect(extremeDelay, greaterThanOrEqualTo(0));
      expect(extremeDelay, lessThanOrEqualTo(30000));
    });

    test('custom baseDelay and maxDelay overrides in calculation', () {
      final fsm = LifecycleFSM<void, void>();

      for (var i = 0; i < 20; i++) {
        final delay =
            fsm.calculateBackoffDelay(0, baseDelayMs: 100, maxDelayMs: 200);
        expect(delay, greaterThanOrEqualTo(0));
        expect(delay, lessThanOrEqualTo(100));
      }
    });

    test('delay generation exhibits randomness across iterations', () {
      final fsm = LifecycleFSM<void, void>(baseDelayMs: 1000);
      final samples = <int>{};
      for (var i = 0; i < 50; i++) {
        samples.add(fsm.calculateBackoffDelay(3)); // max = 8000
      }
      // Over 50 draws from [0, 8000], we should have multiple distinct values
      expect(samples.length, greaterThan(10));
    });
  });
}
