using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace KenMonitorControl {
    static class NativeTheme {
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h,int attribute,ref int value,int size);
        public static void Apply(Form form) {
            try {
                int dark=1,round=2,caption=0x27170f;
                DwmSetWindowAttribute(form.Handle,20,ref dark,4);
                DwmSetWindowAttribute(form.Handle,33,ref round,4);
                DwmSetWindowAttribute(form.Handle,35,ref caption,4);
            }catch(DllNotFoundException){}catch(EntryPointNotFoundException){}
        }
    }
    class RoundedPanel : Panel {
        public int Radius=18;
        public Color FillColor=Color.FromArgb(25,37,56);
        public Color BorderColor=Color.FromArgb(40,57,77);
        public RoundedPanel(){SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.ResizeRedraw|ControlStyles.Opaque,true);BackColor=Color.FromArgb(15,23,39);}
        protected override void OnPaintBackground(PaintEventArgs e){e.Graphics.Clear(BackColor);}
        protected override void OnPaint(PaintEventArgs e){
            e.Graphics.Clear(BackColor);
            e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;
            if(Width>1&&Height>1)using(var p=IconArt.Rounded(new RectangleF(.5f,.5f,Width-1,Height-1),Radius))
            using(var fill=new SolidBrush(FillColor))using(var border=new Pen(BorderColor,1)){e.Graphics.FillPath(fill,p);e.Graphics.DrawPath(border,p);}
            base.OnPaint(e);
        }
    }
    class RoundedButton : Button {
        bool hovered,pressed;
        public int Radius=13;
        public RoundedButton(){SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.SupportsTransparentBackColor,true);FlatStyle=FlatStyle.Flat;FlatAppearance.BorderSize=0;UseVisualStyleBackColor=false;}
        protected override void OnMouseEnter(EventArgs e){hovered=true;Invalidate();base.OnMouseEnter(e);}
        protected override void OnMouseLeave(EventArgs e){hovered=false;pressed=false;Invalidate();base.OnMouseLeave(e);}
        protected override void OnMouseDown(MouseEventArgs e){pressed=true;Invalidate();base.OnMouseDown(e);}
        protected override void OnMouseUp(MouseEventArgs e){pressed=false;Invalidate();base.OnMouseUp(e);}
        protected override void OnGotFocus(EventArgs e){base.OnGotFocus(e);Invalidate();}
        protected override void OnLostFocus(EventArgs e){base.OnLostFocus(e);pressed=false;Invalidate();}
        protected override void OnPaint(PaintEventArgs e){
            Color surface=Parent==null?Color.FromArgb(15,23,39):Parent.BackColor;
            if(surface.A<255)surface=Color.FromArgb(15,23,39);
            e.Graphics.Clear(surface);e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;
            Color color=!Enabled?Color.FromArgb(39,49,65):pressed?ControlPaint.Dark(BackColor,.10f):hovered?ControlPaint.Light(BackColor,.12f):BackColor;
            if(Width>2&&Height>2)using(var p=IconArt.Rounded(new RectangleF(1,1,Width-2,Height-2),Radius))
            using(var fill=new SolidBrush(color))using(var border=new Pen(Color.FromArgb(Focused?130:35,212,237,245),Focused?1.5f:1)){
                e.Graphics.FillPath(fill,p);e.Graphics.DrawPath(border,p);
            }
            TextRenderer.DrawText(e.Graphics,Text,Font,ClientRectangle,Enabled?ForeColor:Color.FromArgb(131,147,166),TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter|TextFormatFlags.EndEllipsis);
        }
    }
    class ToggleCheckBox : CheckBox {
        public ToggleCheckBox(){AutoSize=false;Size=new Size(264,36);BackColor=Color.FromArgb(15,23,39);SetStyle(ControlStyles.UserPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.AllPaintingInWmPaint|ControlStyles.ResizeRedraw|ControlStyles.Opaque,true);}
        protected override void OnPaintBackground(PaintEventArgs e){e.Graphics.Clear(BackColor);}
        protected override void OnCheckedChanged(EventArgs e){base.OnCheckedChanged(e);Invalidate();}
        protected override void OnPaint(PaintEventArgs e){
            e.Graphics.Clear(BackColor);
            e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;
            var track=new RectangleF(1,(Height-22)/2f,38,22);
            using(var p=IconArt.Rounded(track,11))using(var b=new SolidBrush(Checked?Color.FromArgb(42,161,136):Color.FromArgb(64,79,99)))e.Graphics.FillPath(b,p);
            using(var dot=new SolidBrush(Enabled?Color.FromArgb(232,250,245):Color.Gray))e.Graphics.FillEllipse(dot,Checked?20:4,(Height-16)/2f,16,16);
            TextRenderer.DrawText(e.Graphics,Text,Font,new Rectangle(48,0,Width-48,Height),Enabled?ForeColor:Color.Gray,TextFormatFlags.Left|TextFormatFlags.VerticalCenter|TextFormatFlags.EndEllipsis);
            if(Focused)ControlPaint.DrawFocusRectangle(e.Graphics,Rectangle.Inflate(ClientRectangle,-1,-1),ForeColor,BackColor);
        }
    }
    class LayoutGrid : TableLayoutPanel {
        public LayoutGrid(){DoubleBuffered=true;SetStyle(ControlStyles.OptimizedDoubleBuffer|ControlStyles.AllPaintingInWmPaint|ControlStyles.ResizeRedraw,true);}
    }
}
