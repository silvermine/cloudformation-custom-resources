'use strict';

var expect = require('chai').expect,
    sinon = require('sinon'),
    https = require('https'),
    EventEmitter = require('events').EventEmitter,
    BaseResource = require('../src/BaseResource');

describe('BaseResource', function() {

   var baseEvent;

   beforeEach(function() {
      baseEvent = {
         StackId: 'arn:aws:cloudformation:us-east-1:123456789:stack/my-stack/guid',
         RequestId: 'unique-id-1234',
         LogicalResourceId: 'MyResource',
         PhysicalResourceId: 'physical-id-1234',
         ResponseURL: 'https://s3.amazonaws.com/some-bucket/some-key?query=1',
         ResourceProperties: { Foo: 'bar' },
         OldResourceProperties: { Foo: 'baz' },
         RequestType: 'Create',
         ResourceType: 'Custom::Test',
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

      return fakeReq;
   }

   describe('init', function() {

      it('stores the event', function() {
         var resource = new BaseResource(baseEvent);

         expect(resource._event).to.strictlyEqual(baseEvent);
      });

   });

   describe('doCreate / doUpdate / doDelete', function() {

      it('returns an empty object by default', function() {
         var resource = new BaseResource(baseEvent);

         return Promise.all([
            resource.doCreate().then(function(r) {
               expect(r).to.eql({});
            }),
            resource.doUpdate().then(function(r) {
               expect(r).to.eql({});
            }),
            resource.doDelete().then(function(r) {
               expect(r).to.eql({});
            }),
         ]);
      });

   });

   describe('normalizeResourceProperties', function() {

      it('returns props unchanged', function() {
         var resource = new BaseResource(baseEvent),
             props = { Foo: 'bar' },
             result = resource.normalizeResourceProperties(props);

         expect(result).to.strictlyEqual(props);
      });

   });

   describe('handleCreate', function() {

      it('calls doCreate, respond, and _sendResponse', function() {
         var resource = new BaseResource(baseEvent);

         stubHTTPS();

         return resource.handleCreate().then(function(resp) {
            expect(resp.Status).to.strictlyEqual('SUCCESS');
            expect(resp.StackId).to.strictlyEqual(baseEvent.StackId);
            expect(resp.RequestId).to.strictlyEqual(baseEvent.RequestId);
            expect(resp.LogicalResourceId).to.strictlyEqual(baseEvent.LogicalResourceId);
         });
      });

   });

   describe('handleUpdate', function() {

      it('calls doUpdate, respond, and _sendResponse', function() {
         var resource = new BaseResource(baseEvent);

         stubHTTPS();

         return resource.handleUpdate().then(function(resp) {
            expect(resp.Status).to.strictlyEqual('SUCCESS');
            expect(resp.PhysicalResourceId).to.strictlyEqual(baseEvent.PhysicalResourceId);
         });
      });

   });

   describe('handleDelete', function() {

      it('calls doDelete, respond, and _sendResponse', function() {
         var resource = new BaseResource(baseEvent);

         stubHTTPS();

         return resource.handleDelete().then(function(resp) {
            expect(resp.Status).to.strictlyEqual('SUCCESS');
            expect(resp.PhysicalResourceId).to.strictlyEqual(baseEvent.PhysicalResourceId);
         });
      });

   });

   describe('sendError', function() {

      it('sends a FAILED response with the error message', function() {
         var resource = new BaseResource(baseEvent);

         stubHTTPS();

         return resource.sendError(new Error('something broke')).then(function(resp) {
            expect(resp.Status).to.strictlyEqual('FAILED');
            expect(resp.Reason).to.strictlyEqual('something broke');
         });
      });

   });

   describe('_createResponse', function() {

      it('uses PhysicalResourceId from the event when none is supplied', function() {
         var resource = new BaseResource(baseEvent),
             resp = resource._createResponse('SUCCESS', null, null, null);

         expect(resp.PhysicalResourceId).to.strictlyEqual(baseEvent.PhysicalResourceId);
      });

      it('uses the supplied physical resource ID', function() {
         var resource = new BaseResource(baseEvent),
             resp = resource._createResponse('SUCCESS', 'custom-id', { key: 'val' });

         expect(resp.PhysicalResourceId).to.strictlyEqual('custom-id');
         expect(resp.Data).to.eql({ key: 'val' });
      });

      it('generates a random ID when none is available', function() {
         var resource, resp;

         delete baseEvent.PhysicalResourceId;

         resource = new BaseResource(baseEvent);
         resp = resource._createResponse('SUCCESS', null, null);

         expect(resp.PhysicalResourceId).to.be.a('string');
         expect(resp.PhysicalResourceId).to.include(baseEvent.LogicalResourceId);
      });

   });

   describe('_sendResponse', function() {

      it('makes an HTTPS PUT request to the ResponseURL', function() {
         var resource = new BaseResource(baseEvent),
             resp = resource._createResponse('SUCCESS', 'phys-id', {});

         stubHTTPS();

         return resource._sendResponse(resp).then(function() {
            var callArgs = https.request.firstCall.args[0];

            expect(callArgs.hostname).to.strictlyEqual('s3.amazonaws.com');
            expect(callArgs.method).to.strictlyEqual('PUT');
            expect(callArgs.path).to.strictlyEqual('/some-bucket/some-key?query=1');
         });
      });

      it('rejects when the request errors', function() {
         var resource = new BaseResource(baseEvent),
             resp = resource._createResponse('SUCCESS', 'phys-id', {}),
             fakeReq;

         fakeReq = new EventEmitter();
         fakeReq.write = sinon.stub();
         fakeReq.end = sinon.stub();

         sinon.stub(https, 'request').callsFake(function() {
            process.nextTick(function() {
               fakeReq.emit('error', new Error('network fail'));
            });

            return fakeReq;
         });

         return resource._sendResponse(resp)
            .then(function() {
               throw new Error('should have rejected');
            })
            .catch(function(err) {
               expect(err.message).to.strictlyEqual('network fail');
            });
      });

   });

});
