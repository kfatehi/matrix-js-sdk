"use strict";
const sdk = require("../..");
const q = require("q");
const HttpBackend = require("../mock-request");
const utils = require("../../lib/utils");
const testUtils = require("../test-utils");

let aliHttpBackend;
let bobHttpBackend;
let aliClient;
const roomId = "!room:localhost";
const aliUserId = "@ali:localhost";
const aliDeviceId = "zxcvb";
const aliAccessToken = "aseukfgwef";
let bobClient;
const bobUserId = "@bob:localhost";
const bobDeviceId = "bvcxz";
const bobAccessToken = "fewgfkuesa";
let bobOneTimeKeys;
let aliDeviceKeys;
let bobDeviceKeys;
let bobDeviceCurve25519Key;
let bobDeviceEd25519Key;
let aliStorage;
let bobStorage;
let aliMessages;
let bobMessages;


/**
 * Set an expectation that the client will upload device keys and a number of
 * one-time keys; then flush the http requests.
 *
 * @param {string} deviceId expected device id in upload request
 * @param {object} httpBackend
 *
 * @return {promise} completes once the http requests have completed, returning combined
 * {one_time_keys: {}, device_keys: {}}
 */
function expectKeyUpload(deviceId, httpBackend) {
    const uploadPath = "/keys/upload/" + deviceId;
    const keys = {};

    httpBackend.when("POST", uploadPath).respond(200, function(path, content) {
        expect(content.one_time_keys).not.toBeDefined();
        expect(content.device_keys).toBeDefined();
        keys.device_keys = content.device_keys;
        return {one_time_key_counts: {signed_curve25519: 0}};
    });

    httpBackend.when("POST", uploadPath).respond(200, function(path, content) {
        expect(content.device_keys).not.toBeDefined();
        expect(content.one_time_keys).toBeDefined();
        expect(content.one_time_keys).not.toEqual({});
        let count = 0;
        for (const key in content.one_time_keys) {
            if (content.one_time_keys.hasOwnProperty(key)) {
                count++;
            }
        }
        expect(count).toEqual(5);
        keys.one_time_keys = content.one_time_keys;
        return {one_time_key_counts: {signed_curve25519: count}};
    });

    return httpBackend.flush(uploadPath, 2).then(function() {
        return keys;
    });
}


/**
 * Set an expectation that ali will upload device keys and a number of one-time keys;
 * then flush the http requests.
 *
 * <p>Updates <tt>aliDeviceKeys</tt>
 *
 * @return {promise} completes once the http requests have completed.
 */
function expectAliKeyUpload() {
    return expectKeyUpload(aliDeviceId, aliHttpBackend).then(function(content) {
        aliDeviceKeys = content.device_keys;
    });
}


/**
 * Set an expectation that bob will upload device keys and a number of one-time keys;
 * then flush the http requests.
 *
 * <p>Updates <tt>bobDeviceKeys</tt>, <tt>bobOneTimeKeys</tt>,
 * <tt>bobDeviceCurve25519Key</tt>, <tt>bobDeviceEd25519Key</tt>
 *
 * @return {promise} completes once the http requests have completed.
 */
function expectBobKeyUpload() {
    return expectKeyUpload(bobDeviceId, bobHttpBackend).then(function(content) {
        bobDeviceKeys = content.device_keys;
        bobOneTimeKeys = content.one_time_keys;
        expect(bobDeviceKeys).toBeDefined();
        expect(bobOneTimeKeys).toBeDefined();
        bobDeviceCurve25519Key = bobDeviceKeys.keys["curve25519:bvcxz"];
        bobDeviceEd25519Key = bobDeviceKeys.keys["ed25519:bvcxz"];
    });
}

function bobUploadsKeys() {
    bobClient.uploadKeys(5).catch(testUtils.failTest);
    return expectBobKeyUpload();
}


/**
 * Set an expectation that ali will query bobs keys; then flush the http request.
 *
 * @return {promise} resolves once the http request has completed.
 */
function expectAliQueryKeys() {
    // can't query keys before bob has uploaded them
    expect(bobDeviceKeys).toBeDefined();

    const bobKeys = {};
    bobKeys[bobDeviceId] = bobDeviceKeys;
    aliHttpBackend.when("POST", "/keys/query").respond(200, function(path, content) {
        expect(content.device_keys[bobUserId]).toEqual({});
        const result = {};
        result[bobUserId] = bobKeys;
        return {device_keys: result};
    });
    return aliHttpBackend.flush("/keys/query", 1);
}

/**
 * Set an expectation that bob will query alis keys; then flush the http request.
 *
 * @return {promise} which resolves once the http request has completed.
 */
function expectBobQueryKeys() {
    // can't query keys before ali has uploaded them
    expect(aliDeviceKeys).toBeDefined();

    const aliKeys = {};
    aliKeys[aliDeviceId] = aliDeviceKeys;
    bobHttpBackend.when("POST", "/keys/query").respond(200, function(path, content) {
        expect(content.device_keys[aliUserId]).toEqual({});
        const result = {};
        result[aliUserId] = aliKeys;
        return {device_keys: result};
    });
    return bobHttpBackend.flush("/keys/query", 1);
}

/**
 * Set an expectation that ali will claim one of bob's keys; then flush the http request.
 *
 * @return {promise} resolves once the http request has completed.
 */
function expectAliClaimKeys() {
    // can't query keys before bob has uploaded them
    expect(bobOneTimeKeys).toBeDefined();

    aliHttpBackend.when("POST", "/keys/claim").respond(200, function(path, content) {
        const claimType = content.one_time_keys[bobUserId][bobDeviceId];
        expect(claimType).toEqual("signed_curve25519");
        let keyId = null;
        for (keyId in bobOneTimeKeys) {
            if (bobOneTimeKeys.hasOwnProperty(keyId)) {
                if (keyId.indexOf(claimType + ":") === 0) {
                    break;
                }
            }
        }
        const result = {};
        result[bobUserId] = {};
        result[bobUserId][bobDeviceId] = {};
        result[bobUserId][bobDeviceId][keyId] = bobOneTimeKeys[keyId];
        return {one_time_keys: result};
    });

    return aliHttpBackend.flush("/keys/claim", 1);
}


function aliDownloadsKeys() {
    // can't query keys before bob has uploaded them
    expect(bobDeviceEd25519Key).toBeDefined();

    const p1 = aliClient.downloadKeys([bobUserId]).then(function() {
        expect(aliClient.listDeviceKeys(bobUserId)).toEqual([{
            id: "bvcxz",
            key: bobDeviceEd25519Key,
            verified: false,
            blocked: false,
            display_name: null,
        }]);
    });
    const p2 = expectAliQueryKeys();

    // check that the localStorage is updated as we expect (not sure this is
    // an integration test, but meh)
    return q.all([p1, p2]).then(function() {
        const devices = aliStorage.getEndToEndDevicesForUser(bobUserId);
        expect(devices[bobDeviceId].keys).toEqual(bobDeviceKeys.keys);
        expect(devices[bobDeviceId].verified).
            toBe(0); // DeviceVerification.UNVERIFIED
    });
}

function aliEnablesEncryption() {
    return aliClient.setRoomEncryption(roomId, {
        algorithm: "m.olm.v1.curve25519-aes-sha2",
    }).then(function() {
        expect(aliClient.isRoomEncrypted(roomId)).toBeTruthy();
    });
}

function bobEnablesEncryption() {
    return bobClient.setRoomEncryption(roomId, {
        algorithm: "m.olm.v1.curve25519-aes-sha2",
    }).then(function() {
       expect(bobClient.isRoomEncrypted(roomId)).toBeTruthy();
    });
}

/**
 * Ali sends a message, first claiming e2e keys. Set the expectations and
 * check the results.
 *
 * @return {promise} which resolves to the ciphertext for Bob's device.
 */
function aliSendsFirstMessage() {
    return q.all([
        sendMessage(aliClient),
        expectAliQueryKeys()
            .then(expectAliClaimKeys)
            .then(expectAliSendMessageRequest),
    ]).spread(function(_, ciphertext) {
        return ciphertext;
    });
}

/**
 * Ali sends a message without first claiming e2e keys. Set the expectations
 * and check the results.
 *
 * @return {promise} which resolves to the ciphertext for Bob's device.
 */
function aliSendsMessage() {
    return q.all([
        sendMessage(aliClient),
        expectAliSendMessageRequest(),
    ]).spread(function(_, ciphertext) {
        return ciphertext;
    });
}

/**
 * Bob sends a message, first querying (but not claiming) e2e keys. Set the
 * expectations and check the results.
 *
 * @return {promise} which resolves to the ciphertext for Ali's device.
 */
function bobSendsReplyMessage() {
    return q.all([
        sendMessage(bobClient),
        expectBobQueryKeys()
            .then(expectBobSendMessageRequest),
    ]).spread(function(_, ciphertext) {
        return ciphertext;
    });
}

/**
 * Set an expectation that Ali will send a message, and flush the request
 *
 * @return {promise} which resolves to the ciphertext for Bob's device.
 */
function expectAliSendMessageRequest() {
    return expectSendMessageRequest(aliHttpBackend).then(function(content) {
        aliMessages.push(content);
        expect(utils.keys(content.ciphertext)).toEqual([bobDeviceCurve25519Key]);
        const ciphertext = content.ciphertext[bobDeviceCurve25519Key];
        expect(ciphertext).toBeDefined();
        return ciphertext;
    });
}

/**
 * Set an expectation that Bob will send a message, and flush the request
 *
 * @return {promise} which resolves to the ciphertext for Bob's device.
 */
function expectBobSendMessageRequest() {
    return expectSendMessageRequest(bobHttpBackend).then(function(content) {
        bobMessages.push(content);
        const aliKeyId = "curve25519:" + aliDeviceId;
        const aliDeviceCurve25519Key = aliDeviceKeys.keys[aliKeyId];
        expect(utils.keys(content.ciphertext)).toEqual([aliDeviceCurve25519Key]);
        const ciphertext = content.ciphertext[aliDeviceCurve25519Key];
        expect(ciphertext).toBeDefined();
        return ciphertext;
    });
}

function sendMessage(client) {
    return client.sendMessage(
        roomId, {msgtype: "m.text", body: "Hello, World"},
    );
}

function expectSendMessageRequest(httpBackend) {
    const path = "/send/m.room.encrypted/";
    let sent;
    httpBackend.when("PUT", path).respond(200, function(path, content) {
        sent = content;
        return {
            event_id: "asdfgh",
        };
    });
    return httpBackend.flush(path, 1).then(function() {
        return sent;
    });
}

function aliRecvMessage() {
    const message = bobMessages.shift();
    return recvMessage(aliHttpBackend, aliClient, bobUserId, message);
}

function bobRecvMessage() {
    const message = aliMessages.shift();
    return recvMessage(bobHttpBackend, bobClient, aliUserId, message);
}

function recvMessage(httpBackend, client, sender, message) {
    const syncData = {
        next_batch: "x",
        rooms: {
            join: {

            },
        },
    };
    syncData.rooms.join[roomId] = {
        timeline: {
            events: [
                testUtils.mkEvent({
                    type: "m.room.encrypted",
                    room: roomId,
                    content: message,
                    sender: sender,
                }),
            ],
        },
    };
    httpBackend.when("GET", "/sync").respond(200, syncData);
    const deferred = q.defer();
    const onEvent = function(event) {
        console.log(client.credentials.userId + " received event",
                    event);

        // ignore the m.room.member events
        if (event.getType() == "m.room.member") {
            return;
        }

        expect(event.getType()).toEqual("m.room.message");
        expect(event.getContent()).toEqual({
            msgtype: "m.text",
            body: "Hello, World",
        });
        expect(event.isEncrypted()).toBeTruthy();

        client.removeListener("event", onEvent);
        deferred.resolve();
    };

    client.on("event", onEvent);

    httpBackend.flush();
    return deferred.promise;
}


function aliStartClient() {
    expectAliKeyUpload().catch(testUtils.failTest);

    // ali will try to query her own keys on start
    aliHttpBackend.when("POST", "/keys/query").respond(200, function(path, content) {
        expect(content.device_keys[aliUserId]).toEqual({});
        const result = {};
        result[aliUserId] = {};
        return {device_keys: result};
    });

    startClient(aliHttpBackend, aliClient);
    return aliHttpBackend.flush().then(function() {
        console.log("Ali client started");
    });
}

function bobStartClient() {
    expectBobKeyUpload().catch(testUtils.failTest);

    // bob will try to query his own keys on start
    bobHttpBackend.when("POST", "/keys/query").respond(200, function(path, content) {
        expect(content.device_keys[bobUserId]).toEqual({});
        const result = {};
        result[bobUserId] = {};
        return {device_keys: result};
    });

    startClient(bobHttpBackend, bobClient);
    return bobHttpBackend.flush().then(function() {
        console.log("Bob client started");
    });
}


/**
 * Set http responses for the requests which are made when a client starts, and
 * start the client.
 *
 * @param {object} httpBackend
 * @param {MatrixClient} client
 */
function startClient(httpBackend, client) {
    httpBackend.when("GET", "/pushrules").respond(200, {});
    httpBackend.when("POST", "/filter").respond(200, { filter_id: "fid" });

    // send a sync response including our test room.
    const syncData = {
        next_batch: "x",
        rooms: {
            join: { },
        },
    };
    syncData.rooms.join[roomId] = {
        state: {
            events: [
                testUtils.mkMembership({
                    mship: "join",
                    user: aliUserId,
                }),
                testUtils.mkMembership({
                    mship: "join",
                    user: bobUserId,
                }),
            ],
        },
        timeline: {
            events: [],
        },
    };
    httpBackend.when("GET", "/sync").respond(200, syncData);

    client.startClient();
}


describe("MatrixClient crypto", function() {
    if (!sdk.CRYPTO_ENABLED) {
        return;
    }

    beforeEach(function() {
        testUtils.beforeEach(this); // eslint-disable-line no-invalid-this

        aliStorage = new sdk.WebStorageSessionStore(new testUtils.MockStorageApi());
        aliHttpBackend = new HttpBackend();
        aliClient = sdk.createClient({
            baseUrl: "http://alis.server",
            userId: aliUserId,
            accessToken: aliAccessToken,
            deviceId: aliDeviceId,
            sessionStore: aliStorage,
            request: aliHttpBackend.requestFn,
        });

        bobStorage = new sdk.WebStorageSessionStore(new testUtils.MockStorageApi());
        bobHttpBackend = new HttpBackend();
        bobClient = sdk.createClient({
            baseUrl: "http://bobs.server",
            userId: bobUserId,
            accessToken: bobAccessToken,
            deviceId: bobDeviceId,
            sessionStore: bobStorage,
            request: bobHttpBackend.requestFn,
        });

        bobOneTimeKeys = undefined;
        aliDeviceKeys = undefined;
        bobDeviceKeys = undefined;
        bobDeviceCurve25519Key = undefined;
        bobDeviceEd25519Key = undefined;
        aliMessages = [];
        bobMessages = [];
    });

    afterEach(function() {
        aliClient.stopClient();
        bobClient.stopClient();
    });

    it('Ali knows the difference between a new user and one with no devices',
        function(done) {
            aliHttpBackend.when('POST', '/keys/query').respond(200, {
                device_keys: {
                    '@bob:id': {},
                },
            });

            const p1 = aliClient.downloadKeys(['@bob:id']);
            const p2 = aliHttpBackend.flush('/keys/query', 1);

            q.all([p1, p2]).then(function() {
                const devices = aliStorage.getEndToEndDevicesForUser('@bob:id');
                expect(utils.keys(devices).length).toEqual(0);

                // request again: should be no more requests
                return aliClient.downloadKeys(['@bob:id']);
            }).nodeify(done);
        },
    );

    it("Bob uploads without one-time keys and with one-time keys", function(done) {
        q()
            .then(bobUploadsKeys)
            .catch(testUtils.failTest).done(done);
    });

    it("Ali downloads Bobs keys", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliDownloadsKeys)
            .catch(testUtils.failTest).done(done);
    });

    it("Ali gets keys with an invalid signature", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(function() {
                // tamper bob's keys!
                expect(bobDeviceKeys.keys["curve25519:" + bobDeviceId]).toBeDefined();
                bobDeviceKeys.keys["curve25519:" + bobDeviceId] += "abc";

                return q.all(aliClient.downloadKeys([bobUserId]),
                             expectAliQueryKeys());
            })
            .then(function() {
                // should get an empty list
                expect(aliClient.listDeviceKeys(bobUserId)).toEqual([]);
            })
            .catch(testUtils.failTest).done(done);
    });

    it("Ali gets keys with an incorrect userId", function(done) {
        const eveUserId = "@eve:localhost";

        const bobDeviceKeys = {
            algorithms: ['m.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'],
            device_id: 'bvcxz',
            keys: {
                'ed25519:bvcxz': 'pYuWKMCVuaDLRTM/eWuB8OlXEb61gZhfLVJ+Y54tl0Q',
                'curve25519:bvcxz': '7Gni0loo/nzF0nFp9847RbhElGewzwUXHPrljjBGPTQ',
            },
            user_id: '@eve:localhost',
            signatures: {
                '@eve:localhost': {
                    'ed25519:bvcxz': 'CliUPZ7dyVPBxvhSA1d+X+LYa5b2AYdjcTwG' +
                        '0stXcIxjaJNemQqtdgwKDtBFl3pN2I13SEijRDCf1A8bYiQMDg',
                },
            },
        };

        const bobKeys = {};
        bobKeys[bobDeviceId] = bobDeviceKeys;
        aliHttpBackend.when("POST", "/keys/query").respond(200, function(path, content) {
            const result = {};
            result[bobUserId] = bobKeys;
            return {device_keys: result};
        });

        q.all(
            aliClient.downloadKeys([bobUserId, eveUserId]),
            aliHttpBackend.flush("/keys/query", 1),
        ).then(function() {
            // should get an empty list
            expect(aliClient.listDeviceKeys(bobUserId)).toEqual([]);
            expect(aliClient.listDeviceKeys(eveUserId)).toEqual([]);
        }).catch(testUtils.failTest).done(done);
    });

    it("Ali gets keys with an incorrect deviceId", function(done) {
        const bobDeviceKeys = {
            algorithms: ['m.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'],
            device_id: 'bad_device',
            keys: {
                'ed25519:bad_device': 'e8XlY5V8x2yJcwa5xpSzeC/QVOrU+D5qBgyTK0ko+f0',
                'curve25519:bad_device': 'YxuuLG/4L5xGeP8XPl5h0d7DzyYVcof7J7do+OXz0xc',
            },
            user_id: '@bob:localhost',
            signatures: {
                '@bob:localhost': {
                    'ed25519:bad_device': 'fEFTq67RaSoIEVBJ8DtmRovbwUBKJ0A' +
                        'me9m9PDzM9azPUwZ38Xvf6vv1A7W1PSafH4z3Y2ORIyEnZgHaNby3CQ',
                },
            },
        };

        const bobKeys = {};
        bobKeys[bobDeviceId] = bobDeviceKeys;
        aliHttpBackend.when("POST", "/keys/query").respond(200, function(path, content) {
            const result = {};
            result[bobUserId] = bobKeys;
            return {device_keys: result};
        });

        q.all(
            aliClient.downloadKeys([bobUserId]),
            aliHttpBackend.flush("/keys/query", 1),
        ).then(function() {
            // should get an empty list
            expect(aliClient.listDeviceKeys(bobUserId)).toEqual([]);
        }).catch(testUtils.failTest).done(done);
    });

    it("Ali enables encryption", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliStartClient)
            .then(aliEnablesEncryption)
            .catch(testUtils.failTest).done(done);
    });

    it("Ali sends a message", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliStartClient)
            .then(aliEnablesEncryption)
            .then(aliSendsFirstMessage)
            .catch(testUtils.failTest).nodeify(done);
    });

    it("Bob receives a message", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliStartClient)
            .then(aliEnablesEncryption)
            .then(aliSendsFirstMessage)
            .then(bobStartClient)
            .then(bobRecvMessage)
            .catch(testUtils.failTest).done(done);
    });

    it("Bob receives a message with a bogus sender", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliStartClient)
            .then(aliEnablesEncryption)
            .then(aliSendsFirstMessage)
            .then(bobStartClient)
            .then(function() {
                const message = aliMessages.shift();
                const syncData = {
                    next_batch: "x",
                    rooms: {
                        join: {

                        },
                    },
                };
                syncData.rooms.join[roomId] = {
                    timeline: {
                        events: [
                            testUtils.mkEvent({
                                type: "m.room.encrypted",
                                room: roomId,
                                content: message,
                                sender: "@bogus:sender",
                            }),
                        ],
                    },
                };
                bobHttpBackend.when("GET", "/sync").respond(200, syncData);

                const deferred = q.defer();
                const onEvent = function(event) {
                    console.log(bobClient.credentials.userId + " received event",
                                event);

                    // ignore the m.room.member events
                    if (event.getType() == "m.room.member") {
                        return;
                    }

                    expect(event.getType()).toEqual("m.room.message");
                    expect(event.getContent().msgtype).toEqual("m.bad.encrypted");
                    expect(event.isEncrypted()).toBeTruthy();

                    bobClient.removeListener("event", onEvent);
                    deferred.resolve();
                };

                bobClient.on("event", onEvent);

                bobHttpBackend.flush();
                return deferred.promise;
            })
            .catch(testUtils.failTest).done(done);
    });

    it("Ali blocks Bob's device", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliStartClient)
            .then(aliEnablesEncryption)
            .then(aliDownloadsKeys)
            .then(function() {
                aliClient.setDeviceBlocked(bobUserId, bobDeviceId, true);
                const p1 = sendMessage(aliClient);
                const p2 = expectAliQueryKeys()
                    .then(expectAliClaimKeys)
                    .then(function() {
                        return expectSendMessageRequest(aliHttpBackend);
                    }).then(function(sentContent) {
                        // no unblocked devices, so the ciphertext should be empty
                        expect(sentContent.ciphertext).toEqual({});
                    });
                return q.all([p1, p2]);
            }).catch(testUtils.failTest).nodeify(done);
    });

    it("Bob receives two pre-key messages", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliStartClient)
            .then(aliEnablesEncryption)
            .then(aliSendsFirstMessage)
            .then(bobStartClient)
            .then(bobRecvMessage)
            .then(aliSendsMessage)
            .then(bobRecvMessage)
            .catch(testUtils.failTest).done(done);
    });

    it("Bob replies to the message", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliStartClient)
            .then(aliEnablesEncryption)
            .then(aliSendsFirstMessage)
            .then(bobStartClient)
            .then(bobRecvMessage)
            .then(bobEnablesEncryption)
            .then(bobSendsReplyMessage).then(function(ciphertext) {
                expect(ciphertext.type).toEqual(1);
            }).then(aliRecvMessage)
            .catch(testUtils.failTest).done(done);
    });


    it("Ali does a key query when she gets a new_device event", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliStartClient)
            .then(function() {
                const syncData = {
                    next_batch: '2',
                    to_device: {
                        events: [
                            testUtils.mkEvent({
                                content: {
                                    device_id: 'TEST_DEVICE',
                                    rooms: [],
                                },
                                sender: bobUserId,
                                type: 'm.new_device',
                            }),
                        ],
                    },
                };
                aliHttpBackend.when('GET', '/sync').respond(200, syncData);
                return aliHttpBackend.flush('/sync', 1);
            }).then(expectAliQueryKeys)
            .nodeify(done);
    });
});
