'use strict';

exports.load = function load() {
    setTimeout(() => {
        void Editor.Message.request('roundtrip-s0-probe', 'run-probe');
    }, 1_000);
};

exports.unload = function unload() {};
