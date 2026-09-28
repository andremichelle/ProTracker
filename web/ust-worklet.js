/* AudioWorklet processor hosting the UST 1.8 emulator (web/ust.wasm). */

class UstProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.ready = false;
        this.frameCounter = 0;
        this.port.onmessage = (e) => this.onMessage(e.data);
    }

    instantiate(bytes) {
        const module = new WebAssembly.Module(bytes);   // a posted WebAssembly.Module does not reach the worklet in Chrome
        const imports = {};
        for (const imp of WebAssembly.Module.imports(module)) {
            (imports[imp.module] ??= {})[imp.name] = imp.kind === "function" ? () => 0 : undefined;
        }
        const instance = new WebAssembly.Instance(module, imports);
        this.ex = instance.exports;
        this.memory = this.ex.memory;
        if (this.ex._initialize) this.ex._initialize();
        this.ex.ust_init(sampleRate);
    }

    copyToScratch(bytes) {
        const size = this.ex.ust_scratch_size();
        if (bytes.length > size) throw new Error(`file too large (${bytes.length} > ${size})`);
        new Uint8Array(this.memory.buffer, this.ex.ust_scratch(), bytes.length).set(bytes);
        return this.ex.ust_scratch();
    }

    title() {
        const n = this.ex.ust_title();
        return String.fromCharCode(...new Uint8Array(this.memory.buffer, this.ex.ust_scratch(), n));   // no TextDecoder in worklets
    }

    loadedMessage() {
        const ex = this.ex;
        return { type: "loaded", title: this.title(), tickHz: ex.ust_tick_hz() };
    }

    onMessage(msg) {
        try {
            switch (msg.type) {
                case "init": {
                    this.instantiate(msg.wasm);
                    let r = this.ex.ust_load_program(this.copyToScratch(msg.program), msg.program.length);
                    if (r) throw new Error(`load_program failed: ${r}`);
                    r = this.ex.ust_load_module(this.copyToScratch(msg.mod), msg.mod.length);
                    if (r) throw new Error(`load_module failed: ${r}`);
                    this.ready = true;
                    this.port.postMessage(this.loadedMessage());
                    break;
                }
                case "module": {
                    const r = this.ex.ust_load_module(this.copyToScratch(msg.mod), msg.mod.length);
                    if (r) throw new Error(`load_module failed: ${r}`);
                    this.port.postMessage(this.loadedMessage());
                    break;
                }
                case "play":   this.ex.ust_play(); break;
                case "stop":   this.ex.ust_stop(); break;
                case "filter": this.ex.ust_set_filter(msg.value ? 1 : 0); break;
                case "led":    this.ex.ust_set_led(msg.value ? 1 : 0); break;
                case "declick": this.ex.ust_set_declick(msg.value ? 1 : 0); break;
            }
        } catch (err) {
            this.port.postMessage({ type: "error", message: String(err) });
        }
    }

    process(inputs, outputs) {
        const out = outputs[0];
        if (!this.ready || out.length === 0) return true;
        const frames = out[0].length;
        this.ex.ust_render(frames);
        const l = new Float32Array(this.memory.buffer, this.ex.ust_out_l(), frames);
        const r = new Float32Array(this.memory.buffer, this.ex.ust_out_r(), frames);
        out[0].set(l);
        if (out.length > 1) out[1].set(r);
        if ((this.frameCounter += frames) >= sampleRate / 50) {
            this.frameCounter = 0;
            const ex = this.ex;
            const chans = [0, 1, 2, 3].map((c) => ({
                period: ex.ust_chan_period(c),
                volume: ex.ust_chan_volume(c),
                dma: ex.ust_chan_dma(c),
                cell: ex.ust_cell(c) >>> 0,
            }));
            this.port.postMessage({
                type: "status",
                speed: ex.ust_speed(),
                tempo: ex.ust_tempo(),
                pos: ex.ust_song_pos(),
                pattern: ex.ust_pattern(),
                row: ex.ust_row(),
                chans,
            });
        }
        return true;
    }
}

registerProcessor("ust-processor", UstProcessor);
