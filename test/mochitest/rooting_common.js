/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

function test_plugAdbDevice() {
  fakeAdbDevice = new FakeAdbDevice();
  return new Promise((resolve, reject) => {
    Devices.register(fakeAdbDevice._serial, fakeAdbDevice);
    is(Object.keys(Devices._devices).length, 1, "Devices._devices has one element");
    setTimeout(() => resolve());
  });
}

function test_unplugAdbDevice() {
  return new Promise((resolve, reject) => {
    Devices.unregister(fakeAdbDevice._serial);
    is(Object.keys(Devices._devices).length, 0, "Devices._devices has no element");

    resolve();
  });
}

function test_ensureRoot(aNeeded) {
  return new Promise((resolve, reject) => {
    is(fakeAdbDevice.runAsRoot, false, "Does not run as root");
    ensureRootIfNeeded().then(() => {
      ok(true, "ensureRootIfNeeded() succeeded");
      is(fakeAdbDevice.runAsRoot, aNeeded, aNeeded ? "Does run as root as needed" : "Does not run as root as needed");
      return resolve();
    }).catch(err => {
      console.debug("ensureRootIfNeeded() failure", err);
      ok(false, "ensureRootIfNeeded() failed");
      return reject();
    });
  });
}
