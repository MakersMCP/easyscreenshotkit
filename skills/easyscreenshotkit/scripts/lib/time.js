"use strict";

// One deadline for the whole run. Every wait and every browser call takes
// what is left of it, so a slow or broken site ends with a clear error
// instead of a hang.
let deadline = Date.now() + 120_000;

function setTimeLimit(ms) {
  deadline = Date.now() + ms;
}

function timeLeft() {
  return deadline - Date.now();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A turn of the event loop, which a pass over a page's links takes every
// TURN links, so a signal to stop the run is heard in the middle of it, as
// a page can link any number of addresses: in one pass with no turn, a page
// of 200,000 links held the run's only thread more than 5 s, and a stop
// that came meanwhile was heard only after it, where makersmcp's supervisor
// kills the run a second after it asks it to stop, which leaves the
// browser's profile in the temp folder.
const TURN = 1000;
const turn = () => new Promise((resolve) => setImmediate(resolve));

module.exports = { setTimeLimit, timeLeft, sleep, turn, TURN };
