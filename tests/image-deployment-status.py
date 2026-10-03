"""Read-only audit of image Storage prerequisites in both Firebase projects.
Uses existing gcloud/Firebase CLI login. Never prints or saves access tokens.
"""
import json
import re
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]

def cli(*args):
    result = subprocess.run(args, capture_output=True, text=True, cwd=ROOT)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result.stdout

access_token = cli('gcloud', 'auth', 'print-access-token').strip()

def api(url):
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + access_token})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        return {'error_status': error.code}

rules_cli = json.loads(cli('node', 'tests/image-rules-status.mjs'))
report = []
for alias, project in [('development', 'open-excalidraw-dev-2'), ('production', 'open-excalidraw-b2ab4')]:
    configured_bucket = project + '.firebasestorage.app'
    buckets = json.loads(cli('gcloud', 'storage', 'buckets', 'list', '--project=' + project, '--format=json(name,cors_config,location)'))
    rules = rules_cli.get(project, {}).get('rules', [])
    try:
        deployed_database, _ = json.JSONDecoder().raw_decode(cli('firebase', 'database:get', '/.settings/rules', '--project', project, '--json').lstrip())
        deployed_database = deployed_database.get('result', deployed_database)
        if isinstance(deployed_database, str):
            deployed_database = json.loads(deployed_database)
        database_rules_match = deployed_database == json.loads((ROOT / 'database.rules.json').read_text())
    except Exception:
        database_rules_match = None
    frontend = []
    base = f'https://{project}.web.app'
    try:
        html = urllib.request.urlopen(base, timeout=30).read().decode()
        for path in re.findall(r'<script[^>]*src="([^"]+)"', html):
            if '/assets/' not in path:
                continue
            bundle = urllib.request.urlopen(base + path, timeout=30).read().decode()
            project_config = re.search(r'VITE_FIREBASE_PROJECT_ID:\s*["`]([^"`]+)["`]', bundle)
            frontend.append({'bundle': path, 'image_transport_present': 'Firebase image functions are not configured.' in bundle and 'boardAsset' in bundle,
                             'firebase_project_matches': bool(project_config and project_config.group(1) == project)})
    except urllib.error.HTTPError as error:
        frontend = [{'http_status': error.code}]
    billing = api(f'https://cloudbilling.googleapis.com/v1/projects/{project}/billingInfo')
    region = 'us-central1' if alias == 'development' else 'asia-southeast1'
    gateway = api(f'https://cloudfunctions.googleapis.com/v2/projects/{project}/locations/{region}/functions/boardAsset')
    service = gateway.get('serviceConfig', {})
    gateway_status = {'state': gateway.get('state'), 'region': region,
                      'app_check_enforced': service.get('environmentVariables', {}).get('ASSET_ENFORCE_APP_CHECK') == 'true',
                      'max_instances': service.get('maxInstanceCount'),
                      'concurrency': service.get('maxInstanceRequestConcurrency')}
    migration = json.loads(cli('python3', 'tests/image-token-migration.py', '--project', project))
    report.append({'alias': alias, 'project': project, 'configured_bucket': configured_bucket,
                   'image_gateway': gateway_status, 'image_tokens': migration,
                   'configured_bucket_exists': any(b['name'] == configured_bucket for b in buckets),
                   'buckets': buckets, 'billing_enabled': billing.get('billingEnabled'),
                   'database_rules_match_local': database_rules_match, 'rules': rules, 'rules_api_error': rules_cli.get(project, {}).get('error'), 'frontend': frontend})
print(json.dumps({'checked_at_utc': datetime.now(timezone.utc).isoformat(), 'projects': report}, indent=2))
