"""Tests for TripSettings flex-planning fields: no_drive_window, max_drive_hours_per_day."""

import pytest
from pydantic import ValidationError

from shared.models.trip import NoDriveWindow, TripSettings


class TestNoDriveWindowBounds:
    def test_default_is_22_to_6(self):
        w = NoDriveWindow()
        assert w.start_hour == 22
        assert w.end_hour == 6

    def test_custom_window_accepted(self):
        w = NoDriveWindow(start_hour=23, end_hour=5)
        assert w.start_hour == 23
        assert w.end_hour == 5

    def test_hour_24_rejected(self):
        with pytest.raises(ValidationError):
            NoDriveWindow(start_hour=24, end_hour=6)

    def test_negative_hour_rejected(self):
        with pytest.raises(ValidationError):
            NoDriveWindow(start_hour=-1, end_hour=6)


class TestTripSettingsFlexFields:
    def test_defaults_are_none(self):
        # Per commit bda8c1d, new trips default to no travel rules enabled;
        # users opt in via settings. NoDriveWindow's own defaults (22→6) still
        # apply when the user explicitly enables the rule.
        s = TripSettings()
        assert s.no_drive_window is None
        assert s.max_drive_hours_per_day is None

    def test_no_drive_window_can_be_disabled(self):
        s = TripSettings(no_drive_window=None)
        assert s.no_drive_window is None

    def test_max_drive_hours_can_be_disabled(self):
        s = TripSettings(max_drive_hours_per_day=None)
        assert s.max_drive_hours_per_day is None

    def test_max_drive_hours_lower_bound(self):
        with pytest.raises(ValidationError):
            TripSettings(max_drive_hours_per_day=0.5)

    def test_max_drive_hours_upper_bound(self):
        with pytest.raises(ValidationError):
            TripSettings(max_drive_hours_per_day=25.0)
