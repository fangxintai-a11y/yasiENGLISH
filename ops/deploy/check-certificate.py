#!/usr/bin/env python3
"""Check the dedicated site's public certificate; Caddy itself performs ACME renewal."""
import argparse
import datetime
import re
import socket
import ssl
import subprocess
import time


def check(host, port, minimum_days=14, reload_service=None):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*', host) or not 1024 <= port <= 65535:
        raise ValueError('Use the dedicated certificate hostname and HTTPS port')
    def expiry():
        with socket.create_connection(('127.0.0.1', port), timeout=10) as stream:
            with ssl.create_default_context().wrap_socket(stream, server_hostname=host) as tls:
                return ssl.cert_time_to_seconds(tls.getpeercert()['notAfter'])
    expires = expiry()
    if expires - time.time() < minimum_days * 86400:
        if reload_service:
            if reload_service != 'band-galaxy-web.service':
                raise ValueError('Only the dedicated website may be reloaded')
            subprocess.run(['systemctl', 'reload', reload_service], check=True)
        # Reload is a configuration recovery action, not a claim that a CA renewed anything.
        raise RuntimeError('Certificate is nearing expiry; inspect the dedicated Caddy ACME logs')
    print('Certificate valid until ' + datetime.datetime.fromtimestamp(expires, datetime.timezone.utc).isoformat())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, default=8443)
    parser.add_argument('--minimum-days', type=int, default=14)
    parser.add_argument('--reload-service')
    args = parser.parse_args()
    check(args.host, args.port, args.minimum_days, args.reload_service)
