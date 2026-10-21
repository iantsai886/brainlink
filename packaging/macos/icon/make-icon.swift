// Renders the BrainLink app icon (1024×1024 PNG): two linked notes on a green tile.
import AppKit
let size: CGFloat = 1024
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
let tile = NSBezierPath(roundedRect: NSRect(x: 100, y: 100, width: 824, height: 824), xRadius: 185, yRadius: 185)
NSGradient(starting: NSColor(calibratedRed: 0.20, green: 0.42, blue: 0.36, alpha: 1), ending: NSColor(calibratedRed: 0.11, green: 0.25, blue: 0.22, alpha: 1))!.draw(in: tile, angle: -90)
let cream = NSColor(calibratedRed: 0.96, green: 0.95, blue: 0.91, alpha: 1)
func note(_ x: CGFloat, _ y: CGFloat) {
  let r = NSRect(x: x, y: y, width: 250, height: 310)
  cream.setFill(); NSBezierPath(roundedRect: r, xRadius: 36, yRadius: 36).fill()
  NSColor(calibratedRed: 0.20, green: 0.42, blue: 0.36, alpha: 0.55).setFill()
  for i in 0..<4 { NSBezierPath(roundedRect: NSRect(x: x + 42, y: y + 220 - CGFloat(i) * 52, width: i == 3 ? 100 : 166, height: 20), xRadius: 10, yRadius: 10).fill() }
}
note(215, 470); note(560, 245)
let link = NSBezierPath(); link.lineWidth = 34; link.lineCapStyle = .round
link.move(to: NSPoint(x: 465, y: 560)); link.curve(to: NSPoint(x: 560, y: 470), controlPoint1: NSPoint(x: 540, y: 560), controlPoint2: NSPoint(x: 500, y: 470))
NSColor(calibratedRed: 0.93, green: 0.74, blue: 0.40, alpha: 1).setStroke(); link.stroke()
for p in [NSPoint(x: 465, y: 560), NSPoint(x: 560, y: 470)] { NSColor(calibratedRed: 0.93, green: 0.74, blue: 0.40, alpha: 1).setFill(); NSBezierPath(ovalIn: NSRect(x: p.x - 40, y: p.y - 40, width: 80, height: 80)).fill() }
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
