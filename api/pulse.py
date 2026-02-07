import os
from urllib.parse import parse_qs, urlparse

from echo_mind.pulse import run_pulse


def handler(request):
    # Auth check
    secret = os.environ.get("ECHO_CRON_SECRET")

    if secret:
        header_secret = request.headers.get("x-echo-cron-secret")
        qs = parse_qs(urlparse(request.url).query)
        q_secret = (qs.get("secret") or [None])[0]

        if header_secret != secret and q_secret != secret:
            return {
                "statusCode": 401,
                "body": "unauthorized",
            }

    if not os.environ.get("OPENAI_API_KEY"):
        return {
            "statusCode": 500,
            "body": "OPENAI_API_KEY not set",
        }

    result = run_pulse(mode="pulse")

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": str(result),
    }
