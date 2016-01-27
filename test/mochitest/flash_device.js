/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Cu = Components.utils;

var fakeAdbDevice, fakeFastbootDevice;

Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/osfile.jsm");

const kB2GInstallerTmp = FileUtils.getDir("TmpD", ["b2g-installer"], true).path;

function populateFakeDevices() {
  return loadFakeDevice().then(() => {
    fakeAdbDevice = new FakeAdbDevice();
    fakeFastbootDevice = new FakeFastbootDevice();

    // Setup fake ADB device to unregister ADB and register Fastboot
    fakeAdbDevice.rebootBootloader = function() {
      dump("Calling rebootBootloader()\n");
      return new Promise((resolve, reject) => {
        w.Devices.unregister(fakeAdbDevice._serial);
        w.Devices.register(fakeFastbootDevice._serial, fakeFastbootDevice);
        setTimeout(() => {
          return resolve();
        });
      });
    };

    // Setup fake Fastboot device to unregister Fastboot and register ADB
    fakeFastbootDevice.reboot = function() {
      return new Promise((resolve, reject) => {
        w.Devices.unregister(fakeFastbootDevice._serial);
        w.Devices.register(fakeAdbDevice._serial, fakeAdbDevice);
        setTimeout(() => {
          continue_assert_finish();
          return resolve();
        });
      });
    };
  });
}

function test_plugAdbDevice() {
  return new Promise((resolve, reject) => {
    w.Devices.register(fakeAdbDevice._serial, fakeAdbDevice);
    setTimeout(() => resolve());
  });
}

function test_unplugAdbDevice() {
  return new Promise((resolve, reject) => {
    w.Devices.unregister(fakeAdbDevice._serial);
    resolve();
  });
}

function select_build(id) {
  return new Promise((resolve, reject) => {
    let devices = c.getElementById("devices");
    ok(devices, "has devices node");

    let e = devices.getElementsByTagName("input")[id];
    ok(e, "has build id", id);
    e.click();

    let fname = e.value.split("/").reverse()[0];
    is(fname.length > 0, true, "has filename non empty");

    resolve(fname);
  });
}

function get_keepdata() {
  let keepDataElement = c.getElementById("keep-data");
  ok(keepDataElement, "has keep data node");
  return c.defaultView.getComputedStyle(keepDataElement);
}

function assert_keepdata_visible() {
  return new Promise((resolve, reject) => {
    let ks = get_keepdata();
    is(ks.display, "block", "keep data display block");
    is(ks.visibility, "visible", "keep data element visible");

    resolve();
  });
}

function assert_keepdata_nonvisible() {
  return new Promise((resolve, reject) => {
    let ks = get_keepdata();
    is(ks.display, "none", "keep data display block");
    is(ks.visibility, "hidden", "keep data element visible");

    resolve();
  });
}

function click_flash() {
  return new Promise((resolve, reject) => {
    let btn = c.getElementById("installBtn");
    ok(btn, "has flash button");
    btn.click();

    resolve();
  });
}

function cleanupTmpDir(zipFileName, checkDataImg, expectedSize) {
  return new Promise((resolve, reject) => {
    let zip     = OS.Path.join(kB2GInstallerTmp, zipFileName);
    let zipFile = new FileUtils.File(zip);

    ok(zipFile.exists(), "zip file is here");
    is(zipFile.fileSize, expectedSize.zipFile, "zip file is proper size");

    let root    = OS.Path.join(kB2GInstallerTmp, zipFileName.split(".")[0]);
    let rootDir = new FileUtils.File(root);

    ok(rootDir.isDirectory(), "target directory exists");

    let images  = OS.Path.join(root, "images");
    let bootImg = new FileUtils.File(OS.Path.join(images, "boot.img"));
    let recoveryImg = new FileUtils.File(OS.Path.join(images, "recovery.img"));
    let dataImg = new FileUtils.File(OS.Path.join(images, "data.img"));
    let systemImg = new FileUtils.File(OS.Path.join(images, "system.img"));

    ok(bootImg.exists(), "boot image file is here");
    is(bootImg.fileSize, expectedSize.bootImg, "boot image file is proper size");

    ok(recoveryImg.exists(), "recovery image file is here");
    is(recoveryImg.fileSize, expectedSize.recoveryImg, "recovery image file is proper size");

    if (checkDataImg === true) {
      ok(dataImg.exists(), "data image file is here");
      is(dataImg.fileSize, expectedSize.dataImg, "data image file is proper size");
    }

    ok(systemImg.exists(), "system image file is here");
    is(systemImg.fileSize, expectedSize.systemImg, "system image file is proper size");

    rootDir.remove(/* recursive */ true);
    ok(!rootDir.exists(), "target directory exists no more");

    zipFile.remove(/* recursive */ false);
    ok(!zipFile.exists(), "zip file is no more here");

    return resolve();
  });
}
