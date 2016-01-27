/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

function loadFakeDevice() {
  return new Promise((resolve, reject) => {
    let code = document.getElementById("fake-adb");
    code.src = "http://mochi.test:8888/chrome/browser/extensions/b2g-installer/test/mochitest/fake_device.js";
    code.addEventListener("load", function loaded() {
      code.removeEventListener("load", loaded);

      let tentative = new FakeAdbDevice();
      is(typeof tentative, "object", "Can create FakeAdbDevice instance");

      return resolve();
    });
  });
}

function loadAboutJs() {
  return new Promise((resolve, reject) => {
    let code = document.getElementById("code");
    code.src = "chrome://b2g-installer/content/about.js";
    code.addEventListener("load", function loaded() {
      code.removeEventListener("load", loaded);

      is(typeof kB2GInstallerTmp, "string", "about.js loaded");

      return resolve();
    });
  });
}

var MockAddonManager = {
  getAddonByID: function(aID, aCallback) {
    let reply = null;
    if (aID === "adbhelper@mozilla.org") {
      reply = {
        userDisabled: false,
        version: "0.8.6"
      };
    }
    aCallback(reply);
  }
};

// will be used by mochitests as shortcuts
var c, w;
function populateAboutB2GInstaller() {
  return new Promise((resolve, reject) => {
    let domParent = document.getElementById("container");
    let b2ginstaller  = document.createElement("iframe");
    b2ginstaller.width  = "1280";
    b2ginstaller.height = "720";
    b2ginstaller.src    = "about:b2g-installer";
    domParent.appendChild(b2ginstaller);

    b2ginstaller.addEventListener("load", function loaded() {
      b2ginstaller.removeEventListener("load", loaded);

      let _content = b2ginstaller.contentDocument;
      is(typeof _content, "object", "has contentDocument");
      c = _content;

      let _window = b2ginstaller.contentWindow;
      is(typeof _window, "object", "has contentWindow");
      w = _window;

      is(typeof _window.Devices, "object", "had Devices.jsm");

      // We fake ADB Helper for all tests
      is(typeof _window.AddonManager, "object", "had AddonManager.jsm");
      _window.AddonManager = MockAddonManager;

      return resolve(_content, _window);
    });
  });
}

function setPrefsAndRunTests() {
  SimpleTest.waitForExplicitFinish();
  SpecialPowers.pushPrefEnv({"set": [
    ["extensions.b2g-installer@mozilla.org.builds", "http://mochi.test:8888/chrome/browser/extensions/b2g-installer/test/mochitest/builds.json"],
  ]}, runTest);
}
