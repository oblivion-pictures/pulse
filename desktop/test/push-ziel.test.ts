import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushZielErlaubt } from '../electron/pushZiel.ts';

const mit = (push_url: unknown) => ({ channel: { id: '1', token: 't', push_url } });

test('Ziele von media-svc sind erlaubt', () => {
  assert.ok(pushZielErlaubt(mit('https://howispulse.com/whep/channel-1-2-abc/whip?token=t')));
  assert.ok(pushZielErlaubt(mit('http://127.0.0.1:8889/channel-1/whip')));
  assert.ok(pushZielErlaubt(mit('rtmps://howispulse.com:1936/channel-1?user=pulse&pass=t')));
  assert.ok(pushZielErlaubt(mit('rtmp://127.0.0.1:1935/channel-1')));
  assert.ok(pushZielErlaubt(mit('srt://127.0.0.1:8890?streamid=publish:x')));
});

test('ohne push_url oder ohne Kanal baut der Sidecar das Ziel selbst', () => {
  assert.ok(pushZielErlaubt({ channel: { id: '1', token: 't' } }));
  assert.ok(pushZielErlaubt({ direct: true }));
  assert.ok(pushZielErlaubt(undefined));
});

test('Dateipfade und fremde Schemata werden abgewiesen', () => {
  assert.equal(pushZielErlaubt(mit('C:\\Users\\x\\Documents\\wichtig.mp4')), false);
  assert.equal(pushZielErlaubt(mit('/home/x/.ssh/authorized_keys.mp4')), false);
  assert.equal(pushZielErlaubt(mit('file:///home/x/a.mkv')), false);
  assert.equal(pushZielErlaubt(mit('tcp://10.0.0.5:9000/x.ts')), false);
  assert.equal(pushZielErlaubt(mit('udp://10.0.0.5:9000')), false);
  assert.equal(pushZielErlaubt(mit(42)), false);
});
