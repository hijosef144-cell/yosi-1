/* Kaspchem icon set — 48×48, 2px strokes. Gold ".a" strokes are the accent that lights up on the active tile. */
(function () {
  var P = {
    'lost-funds': '<circle cx="21" cy="21" r="14"/><circle class="a" cx="21" cy="21" r="7"/><path d="M31.5 31.5L43 43"/>',
    'tax-refunds': '<path d="M11 5h26v38l-4.3-3.2L28.3 43 24 39.8 19.7 43l-4.4-3.2L11 43z"/><path d="M17 15h14M17 22h8"/><path class="a" d="M26 33l6-6"/><circle class="a" cx="26" cy="28" r="1.4"/><circle class="a" cx="32" cy="32" r="1.4"/>',
    'housing': '<path d="M5 23L24 7l19 16"/><path d="M10 20v23h28V20"/><path class="a" d="M20 43V30h8v13"/>',
    'mortgage': '<path d="M5 23L24 7l19 16"/><path d="M10 20v23h28V20"/><circle class="a" cx="24" cy="27" r="4.5"/><path class="a" d="M24 31.5V40M24 36h4"/>',
    'insurance-pension': '<path d="M24 4l16 6v13c0 10-7 17-16 21C15 40 8 33 8 23V10z"/><path class="a" d="M16.5 24l5.5 5.5L32 18.5"/>',
    'payslip-rights': '<path d="M11 4h19l9 9v31H11z"/><path d="M30 4v9h9"/><path d="M17 22h14M17 28h8"/><circle class="a" cx="29" cy="35" r="4.5"/>',
    'national-insurance': '<circle cx="16" cy="16" r="6"/><path d="M5 41c0-7.5 5-12 11-12s11 4.5 11 12"/><path class="a" d="M35.5 20.5c-2.8-4.2-9-1.4-6 4l6 6 6-6c3-5.4-3.2-8.2-6-4z"/>',
    'banking-loans': '<path d="M5 18L24 7l19 11z"/><path d="M10 22v16M19 22v16M29 22v16M38 22v16"/><path class="a" d="M5 43h38"/>',
    'household': '<path d="M24 5a12 12 0 0 0-6.5 22v6h13v-6A12 12 0 0 0 24 5z"/><path d="M19 38h10M21 43h6"/><path class="a" d="M21 27l3-7 3 7"/>',
    'education-work': '<path d="M3 18L24 7l21 11-21 11z"/><path d="M12 23.5v9c0 3 5.5 6 12 6s12-3 12-6v-9"/><path class="a" d="M45 18v12"/>',
    // the quick check: a signpost (it points you to the right topic)
    'quick': '<path d="M24 4v40"/><path d="M16 44h16"/><path d="M24 9h14l4 5.5-4 5.5H24"/><path class="a" d="M24 25H10l-4 5.5 4 5.5h14"/>'
  };
  window.KaspIcon = function (name, size) {
    var s = size || 48;
    return '<svg class="ico" width="' + s + '" height="' + s + '" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (P[name] || '') + '</svg>';
  };
})();
