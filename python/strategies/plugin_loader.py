"""Dynamic plugin loader for custom user-defined strategies."""
from __future__ import annotations
import importlib.util
import sys
from pathlib import Path
from strategies.base import BaseStrategy


def load_plugin(plugin_file: str, plugin_class: str, config: dict) -> BaseStrategy:
    """Dynamically load a strategy class from a Python file."""
    path = Path(plugin_file)
    if not path.exists():
        raise FileNotFoundError(f"Plugin file not found: {plugin_file}")

    spec = importlib.util.spec_from_file_location(plugin_class, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load spec from {plugin_file}")

    module = importlib.util.module_from_spec(spec)
    sys.modules[plugin_class] = module
    spec.loader.exec_module(module)  # type: ignore[union-attr]

    cls = getattr(module, plugin_class, None)
    if cls is None:
        raise AttributeError(f"Class '{plugin_class}' not found in {plugin_file}")
    if not issubclass(cls, BaseStrategy):
        raise TypeError(f"'{plugin_class}' must extend BaseStrategy")

    return cls(config)
