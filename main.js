/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { when: unload } = require("sdk/system/unload");

let {Ci, Cu, Cr} = require("chrome");

let CID = require("chrome").components.ID;
let Cm = require("chrome").components.manager.QueryInterface(Ci.nsIComponentRegistrar);

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

let imagingToolsCls = require("./imaging_tools.js");
let imagingTools = null;

function B2GInstaller() {
}

B2GInstaller.prototype = {
  uri: Services.io.newURI("chrome://b2g-installer/content/about.xhtml", null, null),
  classDescription: "about:b2g-installer B2G Installer",
  classID: CID("11342911-3135-45a8-8d71-737a2b0ad468"),
  contractID: "@mozilla.org/network/protocol/about;1?what=b2g-installer",

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIB2GInstaller]),

  newChannel : function(aURI, aLoadInfo) {
    let chan = Services.io.newChannelFromURIWithLoadInfo(this.uri, aLoadInfo);
    chan.originalURI = aURI;

    if (!imagingTools) {
      imagingTools = new imagingToolsCls();
    }

    imagingTools.init();

    return chan;
  },

  getURIFlags: function(aURI) 0
};

(function registerComponents() {
  let cls = B2GInstaller;
  try {
    const factory = {
      _cls: cls,
      createInstance: function(outer, iid) {
        if (outer) {
          throw Cr.NS_ERROR_NO_AGGREGATION;
        }
        return new cls();
      }
    };
    Cm.registerFactory(cls.prototype.classID, cls.prototype.classDescription, cls.prototype.contractID, factory);
    unload(function() {
      Cm.unregisterFactory(factory._cls.prototype.classID, factory);
    });
  }
  catch (ex) {
    console.error("Failed to register module: " + cls.name + " -- " + ex + "\n");
  }
})();

console.log("B2GInstaller ready\n");

/* vim: set et ts=2 sw=2 : */
