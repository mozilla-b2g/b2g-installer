/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

function loadRequire() {
  var loaderModule = Components.utils.import("resource://gre/modules/commonjs/toolkit/loader.js").Loader;
  var { Loader, Require, Main } = loaderModule;

  var loaderOptions = {
    paths: {
      "./": "resource://test/",
      "": "resource://gre/modules/commonjs/"
    },
    modules: {
      "toolkit/loader": loaderModule
    }
  };

  var loader = Loader(loaderOptions);
  return Require(loader, { id: "./addon" });
}

function run_test() {
  do_get_profile();
  run_next_test();
}
