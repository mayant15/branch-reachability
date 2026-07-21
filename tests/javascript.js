'use strict';

/** @param {number} value */
function classifyJavaScript(value) {
  if (typeof value === 'number') {
    return 'number';
  } else {
    return 'not a number';
  }
}

module.exports.classifyJavaScript = classifyJavaScript;
