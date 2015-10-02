/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Ci = Components.interfaces;
const Cu = Components.utils;
const Cm = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);

Cu.import("resource://gre/modules/Services.jsm");

const REASON = [ "unknown", "startup", "shutdown", "enable", "disable",
                 "install", "uninstall", "upgrade", "downgrade" ];

// Usefull piece of code from :bent
// http://mxr.mozilla.org/mozilla-central/source/dom/workers/test/extensions/bootstrap/bootstrap.js
function registerAddonResourceHandler(data) {
  let file = data.installPath;
  dump("IN registerAddonResourceHandler WITH file=" + file.path);
  let fileuri = file.isDirectory() ?
                Services.io.newFileURI(file) :
                Services.io.newURI("jar:" + file.path + "!/", null, null);
  let resourceName = encodeURIComponent(data.id.replace("@", "at"));

  Services.io.getProtocolHandler("resource").
              QueryInterface(Ci.nsIResProtocolHandler).
              setSubstitution(resourceName, fileuri);

  return "resource://" + resourceName + "/";
}

let mainModule;
let loader;
let unload;

function install(data, reason) {}

function startup(data, reason) {
  for (var p in data) {
    dump("data." + p + "=" + data[p] + "\n");
  }

  let uri = registerAddonResourceHandler(data);

  let loaderModule =
    Cu.import("resource://gre/modules/commonjs/toolkit/loader.js").Loader;
  let { Loader, Require, Main } = loaderModule;
  unload = loaderModule.unload;

  let loaderOptions = {
    paths: {
      "./": uri,
      "": "resource://gre/modules/commonjs/"
    },
    modules: {
      "toolkit/loader": loaderModule
    }
  };

  /**
   * setup a console object that only dumps messages if
   * LOGPREF is true
   */

  const LOGPREF = "extensions.b2g-installer@mozilla.org.debug";
  const LOGPREFIX = "B2G Installer:";

  try {
    Services.prefs.getBoolPref(LOGPREF);
  } catch(e) {
    // Doesn't exist yet
    Services.prefs.setBoolPref(LOGPREF, false);
  }

  function canLog() {
    return Services.prefs.getBoolPref(LOGPREF);
  }

  // In Firefox 44 and later, many DevTools modules were relocated.
  // See https://bugzil.la/912121
  const { ConsoleAPI } = Cu.import("resource://gre/modules/devtools/shared/Console.jsm");
  let _console = new ConsoleAPI();
  loaderOptions.globals = {
    console: {
      log: function(...args) {
        canLog() && _console.log(LOGPREFIX, ...args);
      },
      warn: function(...args) {
        canLog() && _console.warn(LOGPREFIX, ...args);
      },
      error: function(...args) {
        canLog() && _console.error(LOGPREFIX, ...args);
      },
      debug: function(...args) {
        canLog() && _console.debug(LOGPREFIX, ...args);
      }
    }
  }

  loader = Loader(loaderOptions);
  let require_ = Require(loader, { id: "./addon" });
  mainModule = require_("./main");
}

function shutdown(data, reasonCode) {
  let reason = REASON[reasonCode];
  if (loader) {
    unload(loader, reason);
    unload = null;
  }
  if (mainModule && mainModule.shutdown) {
    mainModule.shutdown();
  }
}

function uninstall(data, reason) {}

/* vim: set et ts=2 sw=2 : */
