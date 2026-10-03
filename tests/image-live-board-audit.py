"""Read-only live board/image audit. Reports locators and sizes, never bytes or tokens."""
import argparse
import json
import subprocess
import urllib.error
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--project', required=True, choices=['open-excalidraw-dev-2', 'open-excalidraw-b2ab4'])
parser.add_argument('--owner', required=True)
parser.add_argument('--workspace-project', required=True)
parser.add_argument('--board', required=True)
args = parser.parse_args()
token = subprocess.check_output(['gcloud', 'auth', 'print-access-token'], text=True).strip()

def api(url):
    try:
        request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise

def decode(value):
    if 'mapValue' in value:
        return {key: decode(item) for key, item in value['mapValue'].get('fields', {}).items()}
    if 'arrayValue' in value:
        return [decode(item) for item in value['arrayValue'].get('values', [])]
    for kind in ['stringValue', 'booleanValue', 'integerValue', 'doubleValue', 'nullValue']:
        if kind in value:
            return value[kind]
    return None

base = f'https://firestore.googleapis.com/v1/projects/{args.project}/databases/(default)/documents/'
bucket = args.project + '.firebasestorage.app'
report = {}
for scope, path in [
    ('private', f'users/{args.owner}/projects/{args.workspace_project}/boards/{args.board}'),
    ('shared', f'boardShares/{args.board}'),
]:
    document = api(base + path)
    if not document:
        report[scope] = None
        continue
    data = decode({'mapValue': {'fields': document['fields']}})
    scene = data.get('scene', {})
    files = []
    for file_id, file in scene.get('files', {}).items():
        storage_path = file.get('storagePath')
        metadata = api('https://storage.googleapis.com/storage/v1/b/' + bucket + '/o/'
                       + urllib.parse.quote(storage_path, safe='')) if storage_path else None
        files.append({'id': file_id, 'storage_path': storage_path,
                      'inline_bytes_empty': file.get('dataURL') == '',
                      'object_exists': metadata is not None,
                      'generation': metadata.get('generation') if metadata else None,
                      'size': metadata.get('size') if metadata else None,
                      'has_download_token': bool(metadata and metadata.get('metadata', {}).get('firebaseStorageDownloadTokens'))})
    report[scope] = {'active': data.get('active', True), 'access': data.get('generalAccess'),
                     'source_project_id': data.get('sourceProjectId'), 'files': files,
                     'images': [{key: element.get(key) for key in ['id', 'fileId', 'x', 'y', 'isDeleted']}
                                for element in scene.get('elements', []) if element.get('type') == 'image']}
print(json.dumps(report, indent=2))
