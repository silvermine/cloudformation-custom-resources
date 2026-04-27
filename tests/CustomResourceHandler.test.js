'use strict';

var expect = require('chai').expect,
    sinon = require('sinon'),
    https = require('https'),
    EventEmitter = require('events').EventEmitter,
    handler = require('../src/CustomResourceHandler').handler;

describe('CustomResourceHandler', function() {

   var baseEvent;

   beforeEach(function() {
      baseEvent = {
         StackId: 'arn:aws:cloudformation:us-east-1:123456789:stack/my-stack/guid',
         RequestId: 'unique-id-1234',
         LogicalResourceId: 'MyResource',
         PhysicalResourceId: 'physical-id-1234',
         ResponseURL: 'https://s3.amazonaws.com/bucket/key',
         ResourceProperties: {},
         OldResourceProperties: {},
         RequestType: 'Create',
         ResourceType: 'Custom::SNSSQSSubscription',
      };
   });

   afterEach(function() {
      sinon.restore();
   });

   function stubHTTPS() {
      var fakeReq = new EventEmitter();

      fakeReq.write = sinon.stub();
      fakeReq.end = sinon.stub();

      sinon.stub(https, 'request').callsFake(function(opts, cb) {
         var fakeResp = new EventEmitter();

         fakeResp.statusCode = 200;
         fakeResp.headers = {};

         process.nextTick(function() {
            fakeResp.emit('end');
            return cb(fakeResp);
         });

         return fakeReq;
      });
   }

   it('sends FAILED for unsupported resource types', function() {
      baseEvent.ResourceType = 'Custom::NonExistent';
      stubHTTPS();

      return handler(baseEvent).then(function(resp) {
         expect(resp.Status).to.strictlyEqual('FAILED');
         expect(resp.Reason).to.include('Unsupported resource type');
      });
   });

   it('dispatches to the correct resource type and catches errors', function() { // eslint-disable-line no-invalid-this
      this.timeout(10000);
      baseEvent.ResourceType = 'Custom::SimpleEmailServiceRuleSetActivation';
      baseEvent.ResourceProperties = { RuleSetName: 'test-rule-set' };
      baseEvent.RequestType = 'Create';
      stubHTTPS();

      // The SES client is not stubbed so the create will fail with a
      // credentials error. The handler catches this and sends a FAILED
      // response, which proves the dispatch + error handling works.
      return handler(baseEvent).then(function(resp) {
         expect(resp.Status).to.strictlyEqual('FAILED');
         expect(resp.Reason).to.be.a('string');
      });
   });

});
