/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var require_ = loadRequire();

var imagingTools;

add_test(function test_load_imagingtools() {
  let cls = require_("./imaging_tools.js");
  imagingTools = new cls();
  run_next_test();
});

add_test(function test_imagingtools_basics() {
  notEqual(imagingTools, undefined, "imagingTools exists");
  notEqual(imagingTools, null, "imagingTools exists");
  run_next_test();
});

add_test(function test_imagingtools_tools() {
  ok(imagingTools._tools.indexOf("mkbootfs") > -1, "tool mkbootfs is defined");
  ok(imagingTools._tools.indexOf("mkbootimg") > -1, "tool mkbootimg is defined");
  ok(imagingTools._tools.indexOf("make_ext4fs") > -1, "tool make_ext4fs is defined");
  run_next_test();
});

add_test(function test_imagingtools_paths_empty() {
  ok(!Object.isFrozen(imagingTools), "Object is not frozen");
  imagingTools._tools   = ["nonExistent"];
  imagingTools._baseURI = "resource://test/";
  try {
    imagingTools.detectBinaries();
  } catch (ex) { } // console.error will stop testing if we don't catch

  equal(Object.keys(imagingTools._paths).length, 0, "no tool found");
  run_next_test();
});

add_test(function test_imagingtools_paths_unsupportedPlatform() {
  ok(!Object.isFrozen(imagingTools), "Object is not frozen");
  imagingTools._tools    = ["nonExistent"];
  imagingTools._baseURI  = "resource://test/";
  let p = imagingTools._platform;
  imagingTools._platform = "none";
  imagingTools.detectBinaries();
  imagingTools._platform = p;

  equal(Object.keys(imagingTools._paths).length, 0, "no tool found");
  run_next_test();
});

add_test(function test_imagingtools_paths_found() {
  ok(!Object.isFrozen(imagingTools), "Object is not frozen");
  imagingTools._tools    = ["subprocess.js"];
  imagingTools._baseURI  = "resource://test/";
  let p = imagingTools._platform;
  imagingTools._platform = "XPCSHELL";
  imagingTools.detectBinaries();
  imagingTools._platform = p;

  equal(Object.keys(imagingTools._paths).length, 1, "one tool found");
  run_next_test();
});
