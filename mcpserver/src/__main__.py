"""Entry point for `python -m mcpserver.src`.

Avoids the __main__ double-import problem: main.py is always loaded as
``mcpserver.src.main`` (never as ``__main__``), so the ``mcp`` FastMCP
instance that tool modules import is the same one that gets served.
"""

from mcpserver.src.main import main

main()
