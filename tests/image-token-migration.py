"""Audit/revoke image download tokens without changing object bytes or other metadata.

Defaults to read-only. Use --apply only after the gateway and restrictive rules
are live. Never prints or saves a token or token-bearing URL.
"""
import argparse
import json
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

parser = argparse.ArgumentParser()
parser.add_argument('--project', required=True, choices=['open-excalidraw-dev-2', 'open-excalidraw-b2ab4'])
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
bucket = args.project + '.firebasestorage.app'
token = subprocess.check_output(['gcloud', 'auth', 'print-access-token'], text=True).strip()
base = 'https://storage.googleapis.com/storage/v1/b/' + bucket

def api(url, body=None):
    request = urllib.request.Request(
        url, data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
        method='PATCH' if body is not None else 'GET',
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)

def image_objects():
    page = None
    while True:
        query = {'fields': 'nextPageToken,items(name,generation,metageneration,size,metadata)', 'maxResults': '1000'}
        if page:
            query['pageToken'] = page
        result = api(base + '/o?' + urllib.parse.urlencode(query))
        for item in result.get('items', []):
            name = item['name']
            if '/assets/' in name and (name.startswith('boards/') or name.startswith('users/')):
                yield item
        page = result.get('nextPageToken')
        if not page:
            return

objects = list(image_objects())
affected = [item for item in objects if item.get('metadata', {}).get('firebaseStorageDownloadTokens')]
revoked = 0
old_url = None
for item in affected:
    # Probe one former bearer URL after revocation; never read its response body.
    if old_url is None:
        old_url = ('https://firebasestorage.googleapis.com/v0/b/' + bucket + '/o/'
                   + urllib.parse.quote(item['name'], safe='') + '?alt=media&token='
                   + urllib.parse.quote(item['metadata']['firebaseStorageDownloadTokens'].split(',')[0], safe=''))
    if args.apply:
        updated = api(base + '/o/' + urllib.parse.quote(item['name'], safe='')
                      + '?ifMetagenerationMatch=' + item['metageneration'],
                      {'metadata': {**item.get('metadata', {}), 'firebaseStorageDownloadTokens': None}})
        if updated['generation'] != item['generation']:
            raise RuntimeError('Object bytes changed during token migration.')
        if updated.get('metadata', {}).get('firebaseStorageDownloadTokens'):
            raise RuntimeError('Token revocation did not complete.')
        revoked += 1

old_token_status = None
if args.apply and old_url:
    try:
        with urllib.request.urlopen(old_url, timeout=30) as response:
            old_token_status = response.status
    except urllib.error.HTTPError as error:
        old_token_status = error.code
    if old_token_status == 200:
        raise RuntimeError('A revoked token still permits a signed-out download.')

remaining = sum(bool(item.get('metadata', {}).get('firebaseStorageDownloadTokens')) for item in image_objects())
print(json.dumps({
    'checked_at_utc': datetime.now(timezone.utc).isoformat(), 'project': args.project,
    'apply': args.apply, 'image_objects': len(objects), 'token_objects_before': len(affected),
    'revoked_objects': revoked, 'remaining_token_objects': remaining,
    'signed_out_revoked_token_status': old_token_status,
}, indent=2))
if args.apply and remaining:
    raise RuntimeError('Some image download tokens remain.')
