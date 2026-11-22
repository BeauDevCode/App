import {initReconnect} from '@libs/actions/Reconnect';
import * as API from '@libs/API';
import {READ_COMMANDS, WRITE_COMMANDS} from '@libs/API/types';
import * as SequentialQueue from '@libs/Network/SequentialQueue';
import {getIsOffline} from '@libs/NetworkState';

import ONYXKEYS from '@src/ONYXKEYS';

import NetInfo, {NetInfoStateType} from '@react-native-community/netinfo';
import Onyx from 'react-native-onyx';

import getOnyxValue from '../utils/getOnyxValue';
import {createGlobalFetchMock} from '../utils/TestHelper';
import waitForNetworkPromises from '../utils/waitForNetworkPromises';

jest.mock('@libs/ActiveClientManager', () => ({
    isClientTheLeader: jest.fn(() => true),
    isReady: jest.fn(() => Promise.resolve()),
    init: jest.fn(),
    getLogTab: jest.fn(),
}));
jest.mock('@libs/Log');
jest.mock('@react-native-community/netinfo', () => ({
    NetInfoStateType: {unknown: 'unknown'},
    configure: jest.fn(),
    refresh: jest.fn(),
    addEventListener: jest.fn(() => () => {}),
}));

const initialUserMetadata = {accountID: 1};
const savedUserMetadata = {accountID: 1234};

function reportRadioConnection(isConnected: boolean) {
    const listener = jest.mocked(NetInfo.addEventListener).mock.lastCall?.[0];
    if (!listener) {
        throw new Error('NetInfo listener not registered');
    }
    listener({type: NetInfoStateType.unknown, details: null, isConnected, isInternetReachable: null});
}

function queueDisplayNameWrite() {
    return API.write(
        WRITE_COMMANDS.UPDATE_DISPLAY_NAME,
        {firstName: 'Test', lastName: 'User'},
        {successData: [{onyxMethod: Onyx.METHOD.SET, key: ONYXKEYS.USER_METADATA, value: savedUserMetadata}]},
    );
}

async function receiveReadResponse() {
    API.read(READ_COMMANDS.GET_REPORT_PRIVATE_NOTE, {reportID: '1'}, {successData: [{onyxMethod: Onyx.METHOD.SET, key: ONYXKEYS.IS_LOADING_APP, value: false}]});
    await waitForNetworkPromises();
    expect(await getOnyxValue(ONYXKEYS.IS_LOADING_APP)).toBe(false);
}

// TestHelper registers the production middleware. Install the same queue observer as app setup.
beforeAll(initReconnect);

beforeEach(async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    jest.spyOn(globalThis, 'fetch').mockImplementation(createGlobalFetchMock());
    await Onyx.clear();
    await Onyx.set(ONYXKEYS.USER_METADATA, initialUserMetadata);
    await Onyx.set(ONYXKEYS.IS_LOADING_APP, true);
    await waitForNetworkPromises();
    reportRadioConnection(true);
});

afterEach(() => {
    SequentialQueue.resetQueue();
    jest.restoreAllMocks();
});

test('a confirmed read response drains the write persisted while the radio was offline', async () => {
    // Given the radio reports a disconnect and an offline write is saved for later
    reportRadioConnection(false);
    await queueDisplayNameWrite();
    expect(await getOnyxValue(ONYXKEYS.PERSISTED_REQUESTS)).toMatchObject([{command: WRITE_COMMANDS.UPDATE_DISPLAY_NAME}]);
    expect(await getOnyxValue(ONYXKEYS.USER_METADATA)).toEqual(initialUserMetadata);

    // When a read succeeds before NetInfo reports that the radio is back
    await receiveReadResponse();

    // Then the connectivity observer flushes the queue and the write commits its success data
    expect(await getOnyxValue(ONYXKEYS.USER_METADATA)).toEqual(savedUserMetadata);
    expect(await getOnyxValue(ONYXKEYS.PERSISTED_REQUESTS)).toEqual([]);
    expect(await getOnyxValue(ONYXKEYS.PERSISTED_ONGOING_REQUESTS)).toBeFalsy();
});

test('radio recovery leaves an independently paused write queued until unpause', async () => {
    // Given a disconnected radio and a separate queue pause that would normally wait for missing updates
    reportRadioConnection(false);
    SequentialQueue.pause();
    await queueDisplayNameWrite();

    // When a read succeeds while the queue is paused
    await receiveReadResponse();

    // Then the app is online, while the write stays persisted for the pause owner to resume
    expect(getIsOffline()).toBe(false);
    expect(SequentialQueue.isPaused()).toBe(true);
    expect(await getOnyxValue(ONYXKEYS.PERSISTED_REQUESTS)).toMatchObject([{command: WRITE_COMMANDS.UPDATE_DISPLAY_NAME}]);
    expect(await getOnyxValue(ONYXKEYS.USER_METADATA)).toEqual(initialUserMetadata);

    // When the pause owner is done and resumes the queue
    SequentialQueue.unpause();
    await waitForNetworkPromises();

    // Then the write applies its success data and is removed from the queue
    expect(await getOnyxValue(ONYXKEYS.USER_METADATA)).toEqual(savedUserMetadata);
    expect(await getOnyxValue(ONYXKEYS.PERSISTED_REQUESTS)).toEqual([]);
});
