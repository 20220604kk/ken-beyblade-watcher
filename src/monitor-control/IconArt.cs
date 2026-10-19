using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace KenMonitorControl {
    // Shared, deterministic artwork for desktop sizes and the in-app brand mark.
    static class IconArt {
        public static GraphicsPath Rounded(RectangleF r,float radius) {
            var p=new GraphicsPath();float d=Math.Max(1,Math.Min(radius*2,Math.Min(r.Width,r.Height)));
            p.AddArc(r.X,r.Y,d,d,180,90);p.AddArc(r.Right-d,r.Y,d,d,270,90);
            p.AddArc(r.Right-d,r.Bottom-d,d,d,0,90);p.AddArc(r.X,r.Bottom-d,d,d,90,90);p.CloseFigure();return p;
        }
        public static Bitmap Render(int size) {
            var bitmap=new Bitmap(size,size,PixelFormat.Format32bppArgb);
            using(var g=Graphics.FromImage(bitmap)) {
                g.SmoothingMode=SmoothingMode.AntiAlias;g.PixelOffsetMode=PixelOffsetMode.HighQuality;
                g.ScaleTransform(size/256f,size/256f);g.Clear(Color.Transparent);
                using(var outline=Rounded(new RectangleF(5,5,246,246),59))
                using(var fill=new LinearGradientBrush(new Rectangle(0,0,256,256),Color.FromArgb(32,59,77),Color.FromArgb(12,23,42),55))g.FillPath(fill,outline);
                using(var outline=Rounded(new RectangleF(7,7,242,242),57))
                using(var edge=new Pen(Color.FromArgb(63,116,133),2))g.DrawPath(edge,outline);
                // Three soft radar sweeps keep the central spinning top legible.
                using(var radar=new Pen(Color.FromArgb(61,107,124),9)) {
                    radar.StartCap=LineCap.Round;radar.EndCap=LineCap.Round;
                    g.DrawArc(radar,39,39,178,178,187,68);g.DrawArc(radar,39,39,178,178,7,68);
                }
                using(var sweep=new Pen(Color.FromArgb(100,229,205),10)){
                    sweep.StartCap=LineCap.Round;sweep.EndCap=LineCap.Round;g.DrawArc(sweep,39,39,178,178,276,56);
                }
                using(var dot=new SolidBrush(Color.FromArgb(131,247,215)))g.FillEllipse(dot,203,73,16,16);
                // Top silhouette: axle, thick elliptical blade, taper, then tip.
                using(var axle=new Pen(Color.FromArgb(212,255,246),14)) {axle.StartCap=LineCap.Round;axle.EndCap=LineCap.Round;g.DrawLine(axle,128,77,128,101);}
                using(var blade=new SolidBrush(Color.FromArgb(84,229,197)))g.FillEllipse(blade,65,94,126,49);
                using(var body=new GraphicsPath()) {
                    body.AddBezier(73,125,88,154,104,168,128,181);
                    body.AddBezier(128,181,152,168,168,154,183,125);body.CloseFigure();
                    using(var shade=new LinearGradientBrush(new Rectangle(72,124,112,59),Color.FromArgb(72,210,187),Color.FromArgb(26,126,149),90))g.FillPath(shade,body);
                }
                using(var blade=new SolidBrush(Color.FromArgb(122,246,213)))g.FillEllipse(blade,65,94,126,39);
                using(var core=new SolidBrush(Color.FromArgb(26,62,77)))g.FillEllipse(core,113,106,30,15);
                using(var tip=new Pen(Color.FromArgb(173,255,231),11)){tip.StartCap=LineCap.Round;tip.EndCap=LineCap.Round;g.DrawLine(tip,128,176,128,190);}
            }return bitmap;
        }
    }
}
