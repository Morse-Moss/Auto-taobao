import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyLoginState, loginPageExpression } from './xws-login.mjs';

test('classifies autofill without exposing values', () => {
  assert.equal(classifyLoginState({ account:{visible:true,autofill:true,length:0}, password:{visible:true,autofill:true,length:0} }), 'AUTOFILL_READY');
  assert.equal(classifyLoginState({ account:{visible:true,autofill:false,length:0}, password:{visible:true,autofill:false,length:0} }), 'NO_SAVED_CREDENTIAL');
  assert.match(loginPageExpression(), /length/);
  assert.doesNotMatch(loginPageExpression(), /account:\s*account\.value|password:\s*password\.value/);
});

test('stops on captcha and accepts populated form', () => {
  assert.equal(classifyLoginState({ captcha:true }), 'CAPTCHA_REQUIRED');
  assert.equal(classifyLoginState({ account:{visible:true,length:3}, password:{visible:true,length:2} }), 'READY_TO_SUBMIT');
});
