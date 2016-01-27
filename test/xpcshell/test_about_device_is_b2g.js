/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Cu = Components.utils;

add_test(function test_load_aboutjs() {
  Cu.import("resource://test/about.js");
  run_next_test();
});

add_test(function test_about_basics() {
  notEqual(checkDeviceIsB2G, undefined, "checkDeviceIsB2G exists");
  run_next_test();
});
