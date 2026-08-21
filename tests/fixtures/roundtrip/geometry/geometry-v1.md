# Geometry v1

Geometry v1 uses only the managed parent's local coordinate space. Page coordinates,
`absoluteBoundingBox`, viewport position, the presentation wrapper, and the protocol root
are excluded.

For the P0 writable subset, all managed ancestors must have no rotation/skew and unit,
positive scale. Positive non-unit scale remains read-only until a real Figma Desktop S0
fixture proves the existing renderer and REST projection are byte-stable.

Let the Cocos parent anchor in Figma's Y-down space be:

```text
parentAnchorX = parent.anchor.x * parent.width
parentAnchorY = (1 - parent.anchor.y) * parent.height
```

Forward projection:

```text
figmaWidth  = cocosWidth  * scaleX
figmaHeight = cocosHeight * scaleY
x = parentAnchorX + positionX - anchorX * figmaWidth
y = parentAnchorY - positionY - (1 - anchorY) * figmaHeight
relativeTransform = [[1, 0, x], [0, 1, y]]
```

Inverse projection uses the frozen source anchor/scale and the same parent canonical state:

```text
cocosWidth  = figmaWidth  / sourceScaleX
cocosHeight = figmaHeight / sourceScaleY
positionX = x - parentAnchorX + sourceAnchorX * figmaWidth
positionY = parentAnchorY - y - (1 - sourceAnchorY) * figmaHeight
```

All returned P0 decimal fields are quantized to four places with decimal-string
half-away-from-zero. The property-test seed is `0xC0C05F1A` and covers 1,000 vectors.
