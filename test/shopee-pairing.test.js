import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {normalizePairingToken,validatePairingToken} from '../extensions/shopee-monitor/pairing.js';
test('generated 64-character hex tokens pass without changes',()=>{const code=randomBytes(32).toString('hex');assert.equal(validatePairingToken(code),code);});
test('paste whitespace, invisible characters and uppercase normalize safely',()=>{const code='ab09'.repeat(16);assert.equal(validatePairingToken(' \n'+code.toUpperCase().slice(0,32)+'\u200B \n'+code.toUpperCase().slice(32)+' '),code);});
test('empty, masked, truncated and invalid tokens have actionable non-secret errors',()=>{assert.throws(()=>validatePairingToken(''),/尚未貼上/);assert.throws(()=>validatePairingToken('•'.repeat(64)),/遮罩/);assert.throws(()=>validatePairingToken('a'.repeat(63)),/63.*64/);assert.throws(()=>validatePairingToken('z'.repeat(64)),/非預期/);});
test('normalization never truncates extra characters into a valid token',()=>{assert.equal(normalizePairingToken('a'.repeat(65)).length,65);assert.throws(()=>validatePairingToken('a'.repeat(65)),/65.*64/);});
