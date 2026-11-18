"""Run after building pi-agent-server. Only synthetic OAuth + preloaded mock fetch."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
WIRE = ['https://chatgpt.com/backend-api/codex/responses', 'POST', 'gpt-6.2-sol', 'ultrafast', 'model=gpt-6.2-sol;tier=ultrafast']

def encoded(data):
    return base64.urlsafe_b64encode(data).decode().rstrip('=')

def verify(fixture):
    token = 'mock.' + encoded(b'{"https://api.openai.com/auth":{"chatgpt_account_id":"fixture"}}') + '.mock'
    nonce = str(uuid.uuid4())
    proof = encoded(hmac.digest(token.encode(), nonce.encode(), hashlib.sha256))
    with tempfile.TemporaryDirectory() as home, tempfile.TemporaryFile(mode='w+') as log:
        env = dict(PATH=os.environ['PATH'], HOME=home, CRAFT_CONFIG_DIR=home, CRAFT_PI_MODEL_API='openai-codex-responses', FIXTURE=fixture)
        child = subprocess.Popen(['bun', '--preload', str(HERE/'ultrafast-fetch.ts'), '--preload', str(ROOT/'packages/shared/src/unified-network-interceptor.ts'), str(HERE.parent/'dist/index.js')], cwd=home, env=env, text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)
        def send(**msg):
            child.stdin.write(json.dumps(msg)+'\n'); child.stdin.flush()
        try:
            send(type='init', model='pi/gpt-6.2-sol-ultrafast', cwd=home, sessionId='offline', workspaceRootPath=home, providerType='pi', authType='oauth', piAuth={'provider':'openai-codex', 'credential':{'type':'api_key','key':token}})
            ids = []
            ends = []
            for line in child.stdout:
                msg = json.loads(line)
                if msg['type'] == 'ready':
                    send(type='prompt', id='first', message='test', systemPrompt='test', ultraNonce=nonce)
                elif msg['type'] == 'ultra_dispatch':
                    assert (msg['nonce'], msg['proof']) == (nonce, proof)
                    assert msg['id'] not in ids
                    if ids:  # duplicate the prior positive decision during the new pending check
                        send(type='ultra_result', id=ids[0], allowed=True)
                    ids.append(msg['id'])
                    # Replacement immediately after first decision, before it reaches the child.
                    send(type='ultra_result', id=msg['id'], allowed=len(ids)==1)
                elif msg['type'] == 'event' and msg['event']['type'] == 'agent_end':
                    ends.append(msg['event']['messages'][-1])
                    if len(ends) == 2: break
                    send(type='prompt', id='later', message='next', systemPrompt='test', ultraNonce=nonce)
            assert len(ids) == len(ends) == 2
            if fixture == 'default':
                assert ends[0]['stopReason'] != 'error' and 'fixture success' in json.dumps(ends[0]), ends[0]
            else: assert ends[0]['stopReason'] == 'error'
            assert ends[1]['stopReason'] == 'error'
            log.seek(0)
            assert [json.loads(line[5:]) for line in log if line.startswith('POST ')] == [WIRE]
            print(f'{fixture}: one POST; stale approval ignored, second dispatch denied')
        finally:
            child.kill(); child.wait()

if __name__ == '__main__':
    def timeout(*_): raise TimeoutError('fixture timed out')
    signal.signal(signal.SIGALRM, timeout)
    for case in ['default','403','429','500','network']:
        signal.alarm(20); verify(case); signal.alarm(0)
