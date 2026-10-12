// Live camera video over WebRTC, for cameras that only stream live that way (Ring, Nest, and others).
// ReflectLive.play(video, "camera.front_door_live_view") resolves to a stop() function once the picture is
// moving, or rejects if the camera can't stream live (callers then fall back to still pictures).
(() => {
  async function play(video, entityId, { timeout = 25000 } = {}) {
    if (typeof RTCPeerConnection === "undefined") throw new Error("Live video isn't supported here.");
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    let sessionId = null, stopped = false;
    const stop = () => {
      if (stopped) return; stopped = true;
      try { pc.close(); } catch {}
      if (video.srcObject) video.srcObject = null;
      if (sessionId) fetch(`/api/homeassistant/live/${sessionId}`, { method: "DELETE", credentials: "same-origin" }).catch(() => {});
    };
    try {
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      const stream = new MediaStream();
      pc.ontrack = (event) => { stream.addTrack(event.track); if (video.srcObject !== stream) video.srcObject = stream; };
      await pc.setLocalDescription(await pc.createOffer());
      // Send the offer with all of this side's network routes in it, so nothing has to follow later.
      await new Promise((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        const done = () => { if (pc.iceGatheringState === "complete") resolve(); };
        pc.addEventListener("icegatheringstatechange", done);
        setTimeout(resolve, 2500);
      });
      const response = await fetch("/api/homeassistant/live", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entityId, offer: pc.localDescription.sdp }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "This camera can't stream live.");
      sessionId = data.id;
      if (stopped) { stop(); throw new Error("Stopped."); }
      await pc.setRemoteDescription({ type: "answer", sdp: data.answer });
      for (const c of data.candidates || []) {
        if (!c?.candidate) continue;
        await pc.addIceCandidate({ candidate: c.candidate, sdpMid: c.sdpMid ?? c.sdp_mid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? c.sdp_m_line_index ?? 0 }).catch(() => {});
      }
      video.muted = true; video.playsInline = true; video.autoplay = true;
      // Wait until frames actually arrive, so callers only swap away from the still picture when there's video.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The live picture didn't start.")), timeout);
        const ok = () => { clearTimeout(timer); resolve(); };
        if (video.readyState >= 2) return ok();
        video.addEventListener("loadeddata", ok, { once: true });
        pc.addEventListener("connectionstatechange", () => { if (pc.connectionState === "failed") { clearTimeout(timer); reject(new Error("The live picture couldn't connect.")); } });
      });
      video.play?.().catch(() => {});
      return stop;
    } catch (error) { stop(); throw error; }
  }
  window.ReflectLive = { play };
})();
