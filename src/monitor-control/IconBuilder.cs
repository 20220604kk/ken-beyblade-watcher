using System;
using System.Collections.Generic;
using System.Drawing.Imaging;
using System.IO;

namespace KenMonitorControl {
    static class IconBuilder {
        static void Main(string[] args) {
            string dir=args[0];Directory.CreateDirectory(dir);
            int[] sizes={16,20,24,32,40,48,64,128,256};var frames=new List<byte[]>();
            foreach(int size in sizes)using(var image=IconArt.Render(size))using(var memory=new MemoryStream()){
                image.Save(memory,ImageFormat.Png);frames.Add(memory.ToArray());
            }
            using(var stream=File.Create(Path.Combine(dir,"ken-monitor.ico")))using(var w=new BinaryWriter(stream)){
                w.Write((ushort)0);w.Write((ushort)1);w.Write((ushort)sizes.Length);int offset=6+16*sizes.Length;
                for(int i=0;i<sizes.Length;i++){
                    w.Write((byte)(sizes[i]==256?0:sizes[i]));w.Write((byte)(sizes[i]==256?0:sizes[i]));
                    w.Write((byte)0);w.Write((byte)0);w.Write((ushort)1);w.Write((ushort)32);
                    w.Write(frames[i].Length);w.Write(offset);offset+=frames[i].Length;
                }foreach(var frame in frames)w.Write(frame);
            }
            using(var preview=IconArt.Render(512))preview.Save(Path.Combine(dir,"ken-monitor.png"),ImageFormat.Png);
        }
    }
}
