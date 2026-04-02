class ConflictError(Exception):
    """Raised when an operation conflicts with current state (e.g., last admin removal)."""
    pass
