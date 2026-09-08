import { EventHandle } from 'playcanvas';

import { Events } from './events';

/**
 * Register global timeline events.
 * The timeline manages playback state (frames, frameRate, current frame, playing).
 * Key management is delegated to individual animation tracks via track.* events.
 */
const registerTimelineEvents = (events: Events) => {
    let frames = 180;
    let frameRate = 30;
    let smoothness = 1;
    let loop = true;

    // camera speed mode: 'constant' = fixed speed, 'variable' = ease near keyframes
    let speedMode: 'constant' | 'variable' = 'constant';
    let playSpeed = 1;      // multiplier for constant mode (0.1 ~ 5)
    const EASE_RANGE = 30;  // frames over which to ease speed near a keyframe
    const SPEED_MIN = 0.2;  // speed at keyframe (20% of base)
    const SPEED_MAX = 2.0;  // speed far from keyframes (200% of base)

    // current frame
    let frame = 0;

    const setFrame = (value: number) => {
        if (value !== frame) {
            frame = value;
            events.fire('timeline.frame', frame);
        }
    };

    events.function('timeline.frame', () => {
        return frame;
    });

    events.on('timeline.setFrame', (value: number) => {
        setFrame(value);
    });

    // frames

    const setFrames = (value: number) => {
        if (value !== frames) {
            frames = value;
            // clamp a stranded playhead before announcing the new length so
            // 'timeline.frames' listeners observe a consistent frame/frames pair
            if (frame >= frames) {
                setFrame(frames - 1);
            }
            events.fire('timeline.frames', frames);
        }
    };

    events.function('timeline.frames', () => {
        return frames;
    });

    events.on('timeline.setFrames', (value: number) => {
        setFrames(value);
    });

    // frame rate

    const setFrameRate = (value: number) => {
        if (value !== frameRate) {
            frameRate = value;
            events.fire('timeline.frameRate', frameRate);
        }
    };

    events.function('timeline.frameRate', () => {
        return frameRate;
    });

    events.on('timeline.setFrameRate', (value: number) => {
        setFrameRate(value);
    });

    // smoothness

    const setSmoothness = (value: number) => {
        if (value !== smoothness) {
            smoothness = value;
            events.fire('timeline.smoothness', smoothness);
        }
    };

    events.function('timeline.smoothness', () => {
        return smoothness;
    });

    events.on('timeline.setSmoothness', (value: number) => {
        setSmoothness(value);
    });

    // loop

    const setLoop = (value: boolean) => {
        if (value !== loop) {
            loop = value;
            events.fire('timeline.loop', loop);
        }
    };

    events.function('timeline.loop', () => {
        return loop;
    });

    events.on('timeline.setLoop', (value: boolean) => {
        setLoop(value);
    });

    // speed mode
    events.function('timeline.speedMode', () => {
        return speedMode;
    });

    events.on('timeline.setSpeedMode', (value: 'constant' | 'variable') => {
        if (value !== speedMode) {
            speedMode = value;
            events.fire('timeline.speedMode', speedMode);
        }
    });

    // playback speed multiplier (constant mode only)
    events.function('timeline.playSpeed', () => {
        return playSpeed;
    });

    events.on('timeline.setPlaySpeed', (value: number) => {
        const clamped = Math.max(0.1, Math.min(5, value));
        if (clamped !== playSpeed) {
            playSpeed = clamped;
            events.fire('timeline.playSpeed', playSpeed);
        }
    });

    // anim controls
    let animHandle: EventHandle = null;

    /**
     * Compute the speed factor for variable-speed mode based on the
     * current frame's distance to the nearest camera keyframe.
     * Returns a factor where 0.2 = slow (near keyframe) and 2.0 = fast (far).
     */
    const getVariableSpeedFactor = (f: number): number => {
        const controller = events.invoke('animation.controller') as any;
        const track = controller?.getTrack?.('camera');
        const keys: number[] = (track?.keys ?? []) as number[];
        if (keys.length < 2) return 1;  // fallback to constant speed

        // find distance to nearest keyframe
        let minDist = Infinity;
        for (const kf of keys) {
            const dist = Math.abs(f - kf);
            if (dist < minDist) minDist = dist;
            if (minDist === 0) break;  // sitting right on a keyframe
        }

        // smoothstep easing: 0 = at keyframe, 1 = beyond easeRange
        const t = Math.min(1, minDist / EASE_RANGE);
        const smoothT = t * t * (3 - 2 * t);
        return SPEED_MIN + (SPEED_MAX - SPEED_MIN) * smoothT;
    };

    const play = () => {
        let time = frame;

        // handle application update tick
        animHandle = events.on('update', (dt: number) => {
            const baseIncrement = dt * frameRate;
            let factor: number;

            if (speedMode === 'variable') {
                factor = getVariableSpeedFactor(Math.floor(time));
            } else {
                factor = playSpeed;
            }

            time = (time + baseIncrement * factor) % frames;
            setFrame(Math.floor(time));
            events.fire('timeline.time', time);
        });
    };

    const stop = () => {
        animHandle.off();
        animHandle = null;
    };

    // playing state
    let playing = false;

    const setPlaying = (value: boolean) => {
        if (value !== playing) {
            playing = value;
            events.fire('timeline.playing', playing);
            if (playing) {
                play();
            } else {
                stop();
            }
        }
    };

    events.function('timeline.playing', () => {
        return playing;
    });

    events.on('timeline.setPlaying', (value: boolean) => {
        setPlaying(value);
    });

    // shortcut handlers
    events.on('timeline.togglePlay', () => {
        setPlaying(!playing);
    });

    events.on('timeline.prevFrame', () => {
        setFrame((frame - 1 + frames) % frames);
    });

    events.on('timeline.nextFrame', () => {
        setFrame((frame + 1) % frames);
    });

    // Key navigation - delegates to active track's keys
    const skipToKey = (dir: 'forward' | 'back') => {
        // ignore keys beyond the end of the timeline - they don't play
        const keys = (events.invoke('track.keys') as number[] ?? []).filter(k => k < frames);

        if (keys.length > 0) {
            const orderedKeys = keys.slice().sort((a, b) => a - b);
            const l = orderedKeys.length;

            const nextKeyIndex = orderedKeys.findIndex(k => (dir === 'back' ? k >= frame : k > frame));

            if (nextKeyIndex === -1) {
                setFrame(orderedKeys[dir === 'back' ? l - 1 : 0]);
            } else {
                setFrame(orderedKeys[dir === 'back' ? (nextKeyIndex + l - 1) % l : nextKeyIndex]);
            }
        } else {
            setFrame(dir === 'back' ? 0 : frames - 1);
        }
    };

    events.on('timeline.prevKey', () => {
        skipToKey('back');
    });

    events.on('timeline.nextKey', () => {
        skipToKey('forward');
    });

    // clear timeline state when scene is cleared
    events.on('scene.clear', () => {
        events.fire('timeline.frames', frames);
    });

    // Serialization - only global state, keys are owned by tracks

    events.function('docSerialize.timeline', () => {
        return {
            frames,
            frameRate,
            frame,
            smoothness,
            loop,
            speedMode,
            playSpeed
        };
    });

    events.function('docDeserialize.timeline', (data: any = {}) => {
        // Set values
        frames = data.frames ?? 180;
        frameRate = data.frameRate ?? 30;
        frame = data.frame ?? 0;
        smoothness = data.smoothness ?? 1;
        loop = data.loop ?? true;
        speedMode = data.speedMode ?? 'constant';
        playSpeed = data.playSpeed ?? 1;

        // Fire events to update UI (always fire to ensure rebuild)
        events.fire('timeline.frames', frames);
        events.fire('timeline.frameRate', frameRate);
        events.fire('timeline.frame', frame);
        events.fire('timeline.smoothness', smoothness);
        events.fire('timeline.loop', loop);
        events.fire('timeline.speedMode', speedMode);
        events.fire('timeline.playSpeed', playSpeed);
    });
};

export { registerTimelineEvents };
