library ucsa_flutter;

import 'package:flutter/widgets.dart';
import 'package:ucsa_dart/ucsa_dart.dart';

export 'package:ucsa_dart/ucsa_dart.dart';

/// A Flutter widget that subscribes to a specific slice of a UCSA query,
/// rebuilding ONLY when the selected slice value actually changes.
class UcsaSelectorBuilder<TData, TSelected> extends StatefulWidget {
  final QueryEngine engine;
  final QueryKey queryKey;
  final TSelected Function(TData data) selector;
  final Widget Function(BuildContext context, TSelected? value) builder;
  final Future<TData> Function()? queryFn;
  final Duration? staleTime;
  final List<String>? tags;

  const UcsaSelectorBuilder({
    super.key,
    required this.engine,
    required this.queryKey,
    required this.selector,
    required this.builder,
    this.queryFn,
    this.staleTime,
    this.tags,
  });

  @override
  State<UcsaSelectorBuilder<TData, TSelected>> createState() =>
      _UcsaSelectorBuilderState<TData, TSelected>();
}

class _UcsaSelectorBuilderState<TData, TSelected>
    extends State<UcsaSelectorBuilder<TData, TSelected>> {
  late SelectorObserver<TData, TSelected> _observer;
  void Function()? _unsubscribe;

  @override
  void initState() {
    super.initState();
    _initObserver();
  }

  void _initObserver() {
    _observer = createSelectorObserver<TData, TSelected>(
      widget.engine,
      widget.queryKey,
      widget.selector,
      queryFn: widget.queryFn,
      staleTime: widget.staleTime,
      tags: widget.tags,
    );
    _unsubscribe = _observer.subscribe(() {
      if (mounted) {
        setState(() {});
      }
    });
  }

  @override
  void didUpdateWidget(UcsaSelectorBuilder<TData, TSelected> oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.engine != widget.engine || oldWidget.queryKey != widget.queryKey) {
      _unsubscribe?.call();
      _observer.dispose();
      _initObserver();
    }
  }

  @override
  void dispose() {
    _unsubscribe?.call();
    _observer.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return widget.builder(context, _observer.getSnapshot());
  }
}
