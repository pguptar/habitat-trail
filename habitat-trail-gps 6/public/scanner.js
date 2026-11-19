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
  var loaded = [], loading = null, turn = 0, latest = {};

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
          var model = await tflite.loadTFLiteModel(m.file);
          var inp = model.inputs[0];
          loaded.push({ id: m.id, g: m.g, model: model, labels: labels,
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
    var scale = max > 1.5 ? 255 : 1, best = -1, bs = -1, bg = 0;
    for (var j = 0; j < d.length; j++) {
      var name = m.labels[j];
      if (!name) continue;
      if (/^background$/i.test(name)) { bg = d[j]; continue; }
      if (d[j] > bs) { bs = d[j]; best = j; }
    }
    /* Each brain has a "background" answer meaning "this isn't my kind of thing".
       If that beats its best species, the brain stays quiet. */
    var r = { model: m.id, g: m.g, sci: best >= 0 && bs > bg ? m.labels[best] : '', score: best >= 0 && bs > bg ? bs / scale : 0, bg: bg / scale, t: Date.now() };
    latest[m.id] = r;
    return r;
  }

  /* Best recent guess across all models. */
  function best(maxAgeMs, only) {
    var now = Date.now(), b = null;
    for (var k in latest) { var r = latest[k]; if (only && k !== only) continue; if (r.sci && now - r.t <= maxAgeMs && (!b || r.score > b.score)) b = r; }
    return b;
  }

  return { load: load, classify: classify, best: best, models: function () { return loaded.map(function (m) { return m.id; }); } };
})();
