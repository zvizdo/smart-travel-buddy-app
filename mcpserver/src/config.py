"""MCP server configuration from environment variables."""

import os

from dotenv import load_dotenv

load_dotenv()


def get_config() -> dict:
    return {
        "api_key_hmac_secret": os.environ["API_KEY_HMAC_SECRET"],
        "google_cloud_project": os.environ.get("GOOGLE_CLOUD_PROJECT", ""),
        "google_maps_api_key": os.environ.get("GOOGLE_MAPS_API_KEY", ""),
    }
