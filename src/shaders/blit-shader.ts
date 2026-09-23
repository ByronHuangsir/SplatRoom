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
    // ---- 运动帧随机透明的 resolve（对齐上游 SuperSplat 的 resolveStochastic，2026-09-22 第二十一轮）----
    // resolveMode = 0（**默认**）⇒ 与历史行为**逐字节相同**的纯拷贝（underlay 与降级期缩放都靠这条路）；
    // resolveMode = 1 ⇒ 运动帧把 1 spp 随机采样"还原"成软边：取每个 2×2 quad 的四个样本求平均，
    //   再在相邻 quad 中心之间双线性插值（上游原话：replacing most of the sampling noise with
    //   quantization error）。哨兵 alpha = 2.0 标记"这一像素来自随机采样"，quad 内**没有**哨兵时
    //   原样输出（上游：nothing stochastic nearby: leave the pixel exactly as it was rendered）。
    // 为什么需要它：1 spp 若直接显示，高斯内部 alpha 高的地方整片通过 ⇒ 退化成实心圆盘（用户实测
    // "完全不可看，全是大面积的实心盘"）；求平均 + 插值才能把覆盖率还原成软边。
    uniform float resolveMode;
    uniform vec2 srcTexel;          // 1 / 源纹理尺寸

    vec4 quadAvg(ivec2 quad) {
        ivec2 o = quad * 2;
        vec4 a = texelFetch(srcTexture, o + ivec2(0, 0), 0);
        vec4 b = texelFetch(srcTexture, o + ivec2(1, 0), 0);
        vec4 c = texelFetch(srcTexture, o + ivec2(0, 1), 0);
        vec4 d = texelFetch(srcTexture, o + ivec2(1, 1), 0);
        // 哨兵样本参与平均：颜色照算，alpha 记 1（它在随机路径里就是不透明的）
        a.a = min(a.a, 1.0);
        b.a = min(b.a, 1.0);
        c.a = min(c.a, 1.0);
        d.a = min(d.a, 1.0);
        return (a + b + c + d) * 0.25;
    }

    void main(void) {
        ivec2 texel = ivec2(floor(gl_FragCoord.xy * blitScale));
        vec4 direct = texelFetch(srcTexture, texel, 0);

        if (resolveMode < 0.5) {
            gl_FragColor = direct;      // 历史路径：原样拷贝
            return;
        }

        // 本像素所属 quad；quad 内是否有随机样本
        ivec2 quad = texel >> 1;
        vec4 q0 = texelFetch(srcTexture, quad * 2 + ivec2(0, 0), 0);
        vec4 q1 = texelFetch(srcTexture, quad * 2 + ivec2(1, 0), 0);
        vec4 q2 = texelFetch(srcTexture, quad * 2 + ivec2(0, 1), 0);
        vec4 q3 = texelFetch(srcTexture, quad * 2 + ivec2(1, 1), 0);
        float sentinels = step(1.5, q0.a) + step(1.5, q1.a) + step(1.5, q2.a) + step(1.5, q3.a);
        if (sentinels < 0.5) {
            gl_FragColor = direct;      // 附近没有随机样本：这一像素不属于运动帧的 splat，原样保留
            return;
        }

        // quad 中心之间的双线性插值：本像素相对本 quad 中心的偏移 → 四邻 quad 的权重
        vec2 fc = gl_FragCoord.xy;
        vec2 center = vec2(quad * 2) + 1.0;
        vec2 t = clamp((fc - center) * 0.5, vec2(-0.5), vec2(0.5)) + 0.5;
        vec4 c00 = quadAvg(quad + ivec2(-1, -1));
        vec4 c10 = quadAvg(quad + ivec2(0, -1));
        vec4 c01 = quadAvg(quad + ivec2(-1, 0));
        vec4 c11 = quadAvg(quad);
        vec4 resolved = mix(mix(c00, c10, t.x), mix(c01, c11, t.x), t.y);
        resolved.a = 1.0;               // 解算后的样本是不透明的 splat 覆盖率近似
        gl_FragColor = resolved;
    }
`;

export { vertexShader, fragmentShader };
