'use strict';

// Original worker output and TestError/attachment values are never serialized.
class MusicSafeReporter {
  constructor() {
    this.id = process.env.PEAR_MUSIC_NATIVE_EXPECTED_TEST_ID;
    if (!/^[a-f0-9]{20}-[a-f0-9]{20}$/.test(this.id ?? '')) throw new Error('Music reporter identity is not admitted.');
    this.begins = 0; this.ends = 0;
  }
  emit(event, status, durationMs = 0, tests = 1) {
    process.stdout.write('MUSIC_DIAGNOSTIC_TEST ' + JSON.stringify({ schema: 1, event, scope: 'music-native-c1-f2', id: this.id, status, durationMs, tests }) + '\n');
  }
  invalid() { this.emit('protocol-error', 'invalid', 0, 0); }
  printsToStdio() { return true; }
  onBegin(_config, suite) { if (suite.allTests().length !== 1) this.invalid(); }
  onTestBegin(test) {
    if (test.id !== this.id || ++this.begins !== 1) this.invalid();
    else this.emit('test-begin', 'running');
  }
  onTestEnd(test, result) {
    if (test.id !== this.id || ++this.ends !== 1 || !['passed', 'failed', 'timedOut', 'skipped', 'interrupted'].includes(result.status)
      || !Number.isFinite(result.duration) || result.duration < 0 || result.duration > 86400000) this.invalid();
    else this.emit('test-end', result.status, Math.round(result.duration));
  }
  onEnd(result) {
    if (this.begins !== 1 || this.ends !== 1 || !['passed', 'failed', 'timedout', 'interrupted'].includes(result.status)) this.invalid();
    else this.emit('run-end', result.status);
  }
  onStdOut() {}
  onStdErr() {}
  onError() { this.invalid(); }
}
module.exports = MusicSafeReporter;
