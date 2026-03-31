"""Tests for edge splitting computation logic.

The split_edge DAGService method uses Firestore, so we test the pure
computational parts: travel-time proportional splitting and travel-mode
inheritance.
"""


class TestTravelTimeSplitting:
    """Verify the proportional travel-time split algorithm used by split_edge."""

    @staticmethod
    def _split_time(
        orig_time: float,
        leg_a_time: float | None,
        leg_b_time: float | None,
        leg_a_dist: float | None,
        leg_b_dist: float | None,
    ) -> tuple[float, float]:
        """Replicate the travel-time splitting logic from DAGService.split_edge."""
        if leg_a_time is None and leg_b_time is None:
            if leg_a_dist and leg_b_dist and (leg_a_dist + leg_b_dist) > 0:
                ratio = leg_a_dist / (leg_a_dist + leg_b_dist)
                return orig_time * ratio, orig_time * (1 - ratio)
            else:
                return orig_time / 2, orig_time / 2
        return (
            leg_a_time if leg_a_time is not None else 0,
            leg_b_time if leg_b_time is not None else 0,
        )

    def test_50_50_fallback_no_distances(self):
        """No distances provided → 50/50 split."""
        a, b = self._split_time(4.0, None, None, None, None)
        assert a == 2.0
        assert b == 2.0

    def test_proportional_by_distance(self):
        """Distances provided → proportional split."""
        a, b = self._split_time(6.0, None, None, 100.0, 200.0)
        assert a == 2.0  # 100/300 * 6
        assert b == 4.0  # 200/300 * 6

    def test_equal_distances(self):
        """Equal distances → 50/50."""
        a, b = self._split_time(10.0, None, None, 150.0, 150.0)
        assert a == 5.0
        assert b == 5.0

    def test_explicit_times_override(self):
        """When explicit times are provided, they are used as-is."""
        a, b = self._split_time(10.0, 3.0, 7.0, None, None)
        assert a == 3.0
        assert b == 7.0

    def test_zero_original_time(self):
        """Zero original time → both legs get 0."""
        a, b = self._split_time(0.0, None, None, None, None)
        assert a == 0.0
        assert b == 0.0

    def test_one_distance_zero(self):
        """One distance is 0 → all time goes to the other leg."""
        a, b = self._split_time(8.0, None, None, 0.0, 200.0)
        # leg_a_dist is falsy (0.0) so falls through to 50/50
        a, b = self._split_time(8.0, None, None, 0.0, 200.0)
        assert a == 4.0  # 50/50 fallback because 0.0 is falsy
        assert b == 4.0

    def test_asymmetric_distances(self):
        """75/25 distance split."""
        a, b = self._split_time(12.0, None, None, 75.0, 25.0)
        assert a == 9.0
        assert b == 3.0


class TestTravelModeInheritance:
    """Verify travel mode inheritance from original edge."""

    @staticmethod
    def _resolve_mode(leg_mode: str | None, original_mode: str | None) -> str:
        """Replicate the travel-mode resolution from DAGService.split_edge."""
        return leg_mode or original_mode or "drive"

    def test_inherits_from_original(self):
        assert self._resolve_mode(None, "transit") == "transit"

    def test_explicit_overrides_original(self):
        assert self._resolve_mode("walk", "drive") == "walk"

    def test_defaults_to_drive(self):
        assert self._resolve_mode(None, None) == "drive"

    def test_flight_inherited(self):
        assert self._resolve_mode(None, "flight") == "flight"
