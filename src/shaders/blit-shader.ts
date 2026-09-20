const vertexShader = /* glsl*/ `
    attribute vec2 vertex_position;
    void main(void) {
        gl_Position = vec4(vertex_position, 0.0, 1.0);
    }
`;

// Final blit: copy the offscreen main target onto the backbuffer.
//
// `blitScale` = source size / destination size, so the copy scales with the target instead of
// assuming the two are the same size. That assumption was invisible while the main target was always
// canvas-sized, and it breaks the moment it is not: the interaction-time degradation renders into a
// smaller target (see src/core/motion-quality.ts), and with a plain `texelFetch(gl_FragCoord.xy)`
// copy the picture lands in the bottom-left corner at 1:1 with the rest of the frame reading
// out-of-range texels — i.e. black bands along the top and right (reported by the user on
// 2026-09-21: "移动、缩放时画面会收缩到左下角，在上部、右部产生黑色空间").
//
// With `blitScale = (1, 1)` this is exactly the previous copy: `gl_FragCoord.xy` is `(x + 0.5, y +
// 0.5)`, so `floor((x + 0.5) * 1) == x` — the same texel the old `ivec2(gl_FragCoord.xy)` selected.
const fragmentShader = /* glsl*/ `
    uniform sampler2D srcTexture;
    uniform vec2 blitScale;
    void main(void) {
        ivec2 texel = ivec2(floor(gl_FragCoord.xy * blitScale));
        gl_FragColor = texelFetch(srcTexture, texel, 0);
    }
`;

export { vertexShader, fragmentShader };
