import assert from 'node:assert/strict';
import { commandName } from '../../src/telegram/commandName.js';

assert.equal(commandName('/learn 7d'), '/learn');
assert.equal(commandName('/lessons'), '/lessons');
assert.equal(commandName('/lessoneval'), '/lessoneval');
assert.equal(commandName('/lessons@AngelBot'), '/lessons');
assert.notEqual(commandName('/lessons'), '/learn');

console.log('[test_learning_commands] learning command routing verified');
