// ===================================================================
//  FitX Attendance — Firebase settings (its OWN Firebase project,
//  separate from FitX Call).
//  The GitHub build replaces this file with the FITX_ATT_FIREBASE secret,
//  so normally you never edit it. See README.md.
// ===================================================================
window.FITX_CONFIG = {
  firebase: {
    apiKey: "PASTE_API_KEY",
    authDomain: "",
    projectId: "",
    storageBucket: "",
    messagingSenderId: "",
    appId: ""
  },
  // Employee IDs become hidden logins like  fx-014@fitxatt.local  (no real email needed).
  loginDomain: "fitxatt.local"
};
