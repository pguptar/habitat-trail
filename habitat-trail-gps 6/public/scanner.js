/* Habitat Trail phone AI scanner.
 * Runs Google's free AIY "Nature Explorer" classifiers (plants, birds, insects; trained on iNaturalist photos)
 * on the phone itself, so names appear instantly while the camera moves. No internet or AI cost per scan.
 * Model files go in public/models/ (see README). Any model that is missing is skipped.
 */
window.HTScanner = (function () {
  'use strict';
  var MODELS = [
    { id: 'plants',  file: 'models/plants.tflite',  labels: 'models/aiy_plants_V1_labelmap.csv',  g: 'P' },
    { id: 'birds',   file: 'models/birds.tflite',   labels: 'models/aiy_birds_V1_labelmap.csv',   g: 'B' },
    { id: 'insects', file: 'models/insects.tflite', labels: 'models/aiy_insects_V1_labelmap.csv', g: 'I' }
  ];
  var loaded = [], loading = null, turn = 0, latest = {}, hist = {};
  /* Only species that live around La Canada (the Dex list in species.js) count as answers.
     The models know thousands of species from around the world, and most wrong answers are faraway look-alikes. */
  var LOCAL_ONLY = true, HISTORY = 7, MIN_VOTES = 3;
  function isLocal(sci) { return !!(window.nsci && window.BYSCI && BYSCI[nsci(sci)]); }

  function parseLabels(text) {
    var out = [];
    text.split(/\r?\n/).forEach(function (line, i) {
      if (!line.trim() || (i === 0 && /^id\s*,/i.test(line))) return;
      var c = line.indexOf(',');
      var id = +line.slice(0, c), name = line.slice(c + 1).replace(/^"|"$/g, '').trim();
      if (!isNaN(id)) out[id] = name;
    });
    return out;
  }

  function load() {
    if (loading) return loading;
    loading = (async function () {
      if (!window.tf || !window.tflite) throw new Error('engine');
      tflite.setWasmPath('vendor/tflite/');
      for (var i = 0; i < MODELS.length; i++) {
        var m = MODELS[i];
        try {
          var lr = await fetch(m.labels);
          if (!lr.ok) continue;
          var labels = parseLabels(await lr.text());
          var local = labels.map(function (n) { return n && isLocal(n) ? 1 : 0; });
          var model = await tflite.loadTFLiteModel(m.file);
          var inp = model.inputs[0];
          loaded.push({ id: m.id, g: m.g, model: model, labels: labels, local: local,
            size: (inp.shape && inp.shape[1]) || 224, dtype: inp.dtype || 'int32' });
        } catch (e) { /* missing or broken model: skip it */ }
      }
      return loaded.map(function (m) { return m.id; });
    })();
    return loading;
  }

  /* Runs one model per call (they take turns) and returns that model's best guess. */
  /* only: 'plants', 'birds' or 'insects' to use one brain, or empty for all three taking turns */
  function classify(source, only) {
    if (!loaded.length) return null;
    var pool = only ? loaded.filter(function (x) { return x.id === only; }) : loaded;
    if (!pool.length) return null;
    var m = pool[turn++ % pool.length];
    var scores = tf.tidy(function () {
      var img = tf.browser.fromPixels(source);
      var h = img.shape[0], w = img.shape[1], s = Math.min(h, w);
      var sq = img.slice([Math.floor((h - s) / 2), Math.floor((w - s) / 2), 0], [s, s, 3]);
      var x = tf.image.resizeBilinear(sq, [m.size, m.size]);
      x = m.dtype === 'float32' ? x.div(255) : x.round().toInt();
      var o = m.model.predict(x.expandDims(0));
      if (!(o instanceof tf.Tensor)) o = o[Object.keys(o)[0]];
      return o.squeeze().toFloat();
    });
    var d = scores.dataSync(); scores.dispose();
    var max = 0;
    for (var i = 0; i < d.length; i++) if (d[i] > max) max = d[i];
    var scale = max > 1.5 ? 255 : 1, best = -1, bs = -1, lbest = -1, lbs = -1, bg = 0;
    for (var j = 0; j < d.length; j++) {
      var name = m.labels[j];
      if (!name) continue;
      if (/^background$/i.test(name)) { bg = d[j]; continue; }
      if (d[j] > bs) { bs = d[j]; best = j; }
      if (m.local[j] && d[j] > lbs) { lbs = d[j]; lbest = j; }
    }
    /* Each brain has a "background" answer meaning "this isn't my kind of thing": if it wins, stay quiet.
       A local species only counts if it is close to the brain's overall favourite (not a distant runner-up). */
    var pick = LOCAL_ONLY ? lbest : best, ps = LOCAL_ONLY ? lbs : bs;
    var ok = pick >= 0 && ps > bg && ps >= bs * 0.5;
    var r = { model: m.id, g: m.g, sci: ok ? m.labels[pick] : '', score: ok ? ps / scale : 0, bg: bg / scale, t: Date.now() };
    (hist[m.id] = hist[m.id] || []).push(r);
    if (hist[m.id].length > HISTORY) hist[m.id].shift();
    latest[m.id] = r;
    return r;
  }

  /* Best recent guess across all models. */
  /* The answer most of the recent looks agree on. One lucky frame is not enough. */
  function best(maxAgeMs, only) {
    var now = Date.now(), b = null;
    for (var k in hist) {
      if (only && k !== only) continue;
      var votes = {};
      hist[k].forEach(function (r) {
        if (!r.sci || now - r.t > maxAgeMs * 3) return;
        var v = votes[r.sci] || (votes[r.sci] = { n: 0, sum: 0, last: r });
        v.n++; v.sum += r.score; v.last = r;
      });
      for (var sci in votes) {
        var v = votes[sci];
        if (v.n < MIN_VOTES) continue;
        var c = { model: k, g: v.last.g, sci: sci, score: v.sum / v.n, votes: v.n, t: v.last.t };
        if (!b || c.score * c.votes > b.score * b.votes) b = c;
      }
    }
    return b;
  }

  return { load: load, classify: classify, best: best, models: function () { return loaded.map(function (m) { return m.id; }); } };
})();
