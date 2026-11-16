import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { nonempty, rpcError, REFUSED_CODES, OPT_OUT } from './protocol.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const ENV_KEYS = ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'CODEX_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
// Native userMessage items can echo attached data URLs. Bound each JSONL message, including those echoes.
const MAX_LINE = 64 * 1024 * 1024;
const LINE_TOO_LONG = 'Codex stdout JSONL line exceeded 64 MiB';

// One app-server connection: process lifetime, JSONL framing and request/response correlation.
// Thread ownership and uncertain mutation outcomes belong to the client, never to a restarted process.
export class AppServerTransport {
  constructor({ command = ['codex', 'app-server', '--stdio'], timeoutMs = 30000, env,
    onNotification, onRequest, onDisconnect } = {}) {
    if (!Array.isArray(command) || !command.length) throw new TypeError('command must be a nonempty string array');
    command.forEach((part, index) => nonempty(part, `command[${index}]`));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
      throw new TypeError('timeoutMs must be positive and at most 2147483647');
    }
    if (env !== undefined && (env === null || typeof env !== 'object' || Array.isArray(env))) {
      throw new TypeError('env must be an object');
    }
    this.command = [...command];
    this.timeoutMs = timeoutMs;
    this.env = {};
    for (const key of ENV_KEYS) {
      const value = env && Object.hasOwn(env, key) ? env[key] : process.env[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || value.includes('\0')) throw new TypeError(`env.${key} must be a string without NUL characters`);
      this.env[key] = value;
    }
    this._process = null;
    this._connectPromise = null;
    this._closePromise = null;
    this._closed = false;
    this._failure = null;
    this._nextId = 1;
    this._pending = new Map();
    this._stdout = '';
    this._stdoutBytes = 0;
    this._onNotification = onNotification;
    this._onRequest = onRequest;
    this._onDisconnect = onDisconnect;
  }

  connect() {
    if (this._closed) return Promise.reject(new Error('Codex client is closed'));
    // A failed transport is replaced once per call, coalesced across callers. Thread ownership and
    // uncertain outcomes survive the replacement; nothing is resubmitted.
    if (!this._connectPromise || this._failure) this._connectPromise = this._initialize();
    return this._connectPromise;
  }

  async _initialize() {
    let child;
    try {
      child = spawn(this.command[0], this.command.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'], env: this.env, windowsHide: true,
      });
      Object.assign(this, { _process: child, _failure: null, _stdout: '', _stdoutBytes: 0 });
      // Late events from a replaced process must never fail its successor.
      const fail = error => { if (this._process === child) this.fail(error); };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { if (this._process === child) this.consume(chunk); });
      // Drained, never retained or echoed: stderr may contain credentials.
      child.stderr.resume();
      child.stdin.on('error', error => fail(new Error(`Codex stdin failed: ${error.message}`)));
      child.stdout.on('error', error => fail(new Error(`Codex stdout failed: ${error.message}`)));
      child.stderr.on('error', error => fail(new Error(`Codex stderr failed: ${error.message}`)));
      child.on('error', error => fail(new Error(`Codex app-server failed: ${error.message}`)));
      child.on('close', (code, signal) => {
        if (this._process !== child) return;
        if (this._stdout.trim()) this.consume('\n');
        this.fail(new Error(`Codex app-server disconnected (code ${code}, signal ${signal ?? 'none'})`));
      });
      await this.request('initialize', {
        clientInfo: { name: 'omp_codex_bridge', version: VERSION },
        // Final agent text arrives with item/completed; partial text is not streamed.
        capabilities: { mcpServerOpenaiFormElicitation: true, optOutNotificationMethods: OPT_OUT },
      });
      this.send({ method: 'initialized', params: {} });
    } catch (error) {
      if (!child || this._process === child) this.fail(error);
      throw error;
    }
  }

  consume(chunk) {
    if (this._failure) return;
    const end = chunk.lastIndexOf('\n');
    if (end === -1) {
      // Only new bytes are measured; a partial line is never re-measured.
      this._stdoutBytes += Buffer.byteLength(chunk);
      if (this._stdoutBytes > MAX_LINE) this.fail(new Error(LINE_TOO_LONG));
      else this._stdout += chunk;
      return;
    }
    const lines = (this._stdout + chunk.slice(0, end)).split('\n');
    this._stdout = chunk.slice(end + 1);
    this._stdoutBytes = Buffer.byteLength(this._stdout);
    for (const line of lines) {
      if (Buffer.byteLength(line) > MAX_LINE) { this.fail(new Error(LINE_TOO_LONG)); return; }
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(new Error('Codex emitted invalid JSONL')); return; }
      this.receive(message);
      if (this._failure) return;
    }
    if (this._stdoutBytes > MAX_LINE) this.fail(new Error(LINE_TOO_LONG));
  }

  receive(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.fail(new Error('Codex emitted an invalid RPC message'));
      return;
    }
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) {
        try { this._onRequest(message); }
        catch { this.fail(new Error('Codex emitted an invalid server request')); }
      } else {
        try { this._onNotification(message.method, message.params); }
        catch { this.fail(new Error('Codex emitted an invalid notification')); }
      }
      return;
    }
    const pending = this._pending.get(message.id);
    if (!pending) return;
    this._pending.delete(message.id);
    clearTimeout(pending.timer);
    if (Object.hasOwn(message, 'error')) {
      const error = rpcError(message.error);
      pending.onError?.(error, pending);
      pending.reject(error);
      return;
    }
    try {
      if (!Object.hasOwn(message, 'result')) throw new Error('Codex RPC response has neither result nor error');
      pending.onResult?.(message.result, pending);
      pending.resolve(message.result);
    } catch (error) {
      // A malformed success is not a native rejection. The mutation may already have happened.
      if (!REFUSED_CODES.has(error.code)) {
        error.outcomeUnknown = pending.mutation;
        if (pending.threadId) error.threadId = pending.threadId;
        this.fail(error);
      }
      pending.reject(error);
    }
  }

  send(message) {
    const child = this._process;
    if (this._closed || this._failure || !child?.stdin.writable) throw this._failure ?? new Error('Codex transport is not writable');
    child.stdin.write(`${JSON.stringify(message)}\n`, error => {
      if (error && this._process === child) this.fail(new Error(`Codex write failed: ${error.message}`));
    });
  }

  request(method, params, { mutation = false, onResult, onError, onTimeout, threadId } = {}) {
    if (this._pending.size >= 128) return Promise.reject(new Error('Too many unresolved Codex RPC requests'));
    if (this._closed || this._failure) return Promise.reject(this._failure ?? new Error('Codex client is closed'));
    const id = this._nextId++;
    return new Promise((resolveResult, reject) => {
      const pending = { id, method, threadId, mutation, onResult, onError, resolve: resolveResult, reject, timer: null, timedOut: false };
      pending.timer = setTimeout(() => {
        pending.timedOut = true;
        pending.timer = null;
        const error = new Error(`Codex ${method} timed out${mutation ? '; outcome unknown; no mutation retried' : ''}`);
        error.code = 'RPC_TIMEOUT';
        error.outcomeUnknown = mutation;
        if (threadId) error.threadId = threadId;
        onTimeout?.(error, pending);
        // Retain mutation response handlers: a late reply can reveal the admitted turn or thread.
        if (!mutation) this._pending.delete(id);
        reject(error);
      }, this.timeoutMs);
      this._pending.set(id, pending);
      try { this.send({ id, method, params }); }
      catch (error) {
        clearTimeout(pending.timer);
        this._pending.delete(id);
        reject(error);
      }
    });
  }

  fail(error) {
    if (this._failure) return;
    this._failure = error instanceof Error ? error : new Error(String(error));
    this._stdout = '';
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      const failure = new Error(`${this._failure.message}${pending.mutation ? '; outcome unknown; no mutation retried' : ''}`);
      failure.code = 'DISCONNECTED';
      failure.outcomeUnknown = pending.mutation;
      if (pending.threadId) failure.threadId = pending.threadId;
      pending.reject(failure);
    }
    this._pending.clear();
    this._onDisconnect(this._failure);
    const child = this._process;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }

  close() {
    if (this._closePromise) return this._closePromise;
    this._closed = true;
    const child = this._process;
    const stopped = child && child.exitCode === null && child.signalCode === null
      ? new Promise(resolveClose => child.once('close', resolveClose)) : Promise.resolve();
    this.fail(new Error('Codex client closed'));
    this._closePromise = (async () => {
      if (child) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        let timer;
        await Promise.race([stopped, new Promise(resolveTimeout => { timer = setTimeout(resolveTimeout, 1000); })]);
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await stopped;
      }
    })();
    return this._closePromise;
  }
}
