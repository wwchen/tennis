"""The crop rectangle for one swing.

With `crop_mode="pose"`, the union of the tracked player's pose bounding boxes
across the swing window, padded, then clamped to the frame. The default is
`crop_mode="full"` -- see `Settings.crop_mode` for why -- in which case
`full_frame()` supplies the rect and none of the union maths runs.

Pose rather than motion differencing, for three reasons: pose is already
computed so it costs nothing extra; it follows the *player* rather than
whatever moved, so it does not chase the ball, the other player, or a car
passing behind the court; and it is one implementation instead of the three
near-duplicate motion-box functions the previous code accumulated.

Boxes arrive frame-normalized (0..1) and leave as integer pixels in
source-display space, which is the space ffmpeg's crop filter wants and the
space `probe()` reports dimensions in.
"""


def union(boxes):
    """Smallest box containing all of them, in normalized coordinates."""
    if not boxes:
        return None
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[2] for b in boxes)
    y1 = max(b[3] for b in boxes)
    return x0, y0, x1, y1


def pad(box, fraction):
    """Grow a box by a fraction of its own size, on every side.

    Padding is proportional so a distant player and a near one both get a
    sensible margin, and it uses the larger dimension so a crouching player
    does not end up with a mean horizontal crop.
    """
    if fraction <= 0:
        return box
    x0, y0, x1, y1 = box
    margin = max(x1 - x0, y1 - y0) * fraction
    return x0 - margin, y0 - margin, x1 + margin, y1 + margin


def to_pixels(box, width, height, min_size=32, even=True):
    """Normalized box -> integer pixel rect clamped inside the frame.

    even: round the size up to a multiple of two, because H.264 with yuv420p
    cannot encode odd dimensions -- ffmpeg would either fail or silently
    rescale, which would put the frames in a different space from the crop
    recorded in metadata.
    """
    x0 = int(round(box[0] * width))
    y0 = int(round(box[1] * height))
    x1 = int(round(box[2] * width))
    y1 = int(round(box[3] * height))

    w = max(min_size, x1 - x0)
    h = max(min_size, y1 - y0)
    if even:
        w += w % 2
        h += h % 2

    # Never wider or taller than the frame itself.
    w = min(w, width - (width % 2 if even else 0)) if width else w
    h = min(h, height - (height % 2 if even else 0)) if height else h

    # Slide inside the frame rather than shrinking, so the player stays whole.
    x0 = max(0, min(x0, width - w))
    y0 = max(0, min(y0, height - h))
    return {"x": int(x0), "y": int(y0), "w": int(w), "h": int(h)}


def full_frame(width, height):
    """The whole frame as a `crop` block.

    Both sides rounded down to even: yuv420p subsamples chroma 2x2, so ffmpeg
    refuses an odd dimension, and a 1079-pixel crop fails at render time rather
    than here. Shared with `rect_for`'s no-pose fallback so the rule lives once.
    """
    return {"x": 0, "y": 0,
            "w": int(width) - int(width) % 2,
            "h": int(height) - int(height) % 2,
            "space": "source_display", "static": True}


def rect_for(boxes, width, height, pad_fraction=0.18, min_size=32):
    """Full path: pose boxes -> the `crop` block of a SwingDoc."""
    merged = union(boxes)
    if merged is None:
        # No pose: fall back to the whole frame, so the swing still renders.
        return full_frame(width, height)
    else:
        rect = to_pixels(pad(merged, pad_fraction), width, height,
                         min_size=min_size)
    rect["space"] = "source_display"
    rect["static"] = True
    return rect


def scale_to_long_edge(w, h, long_edge):
    """Output size for a frame still, preserving aspect, both sides even.

    Never upscales: a small crop stays small rather than being blown up into
    a blurry larger file.
    """
    if long_edge <= 0 or max(w, h) <= long_edge:
        out_w, out_h = int(w), int(h)
    elif w >= h:
        out_w = int(long_edge)
        out_h = max(1, int(round(h * long_edge / float(w))))
    else:
        out_h = int(long_edge)
        out_w = max(1, int(round(w * long_edge / float(h))))
    return out_w + out_w % 2, out_h + out_h % 2
