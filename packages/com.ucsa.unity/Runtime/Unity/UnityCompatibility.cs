#if !UNITY_5_3_OR_NEWER && !UNITY_ENGINE
using System;

namespace UnityEngine
{
    /// <summary>
    /// Standalone mock for UnityEngine.Object to enable test execution outside Unity Editor.
    /// </summary>
    public class Object
    {
        public string name { get; set; } = string.Empty;

        public override string ToString() => string.IsNullOrEmpty(name) ? GetType().Name : name;
    }

    /// <summary>
    /// Standalone mock for UnityEngine.Component.
    /// </summary>
    public class Component : Object
    {
        public GameObject gameObject { get; } = new GameObject();
    }

    /// <summary>
    /// Standalone mock for UnityEngine.GameObject.
    /// </summary>
    public class GameObject : Object
    {
        public bool activeSelf { get; set; } = true;
    }

    /// <summary>
    /// Standalone mock for UnityEngine.Behaviour.
    /// </summary>
    public class Behaviour : Component
    {
        public bool enabled { get; set; } = true;
    }

    /// <summary>
    /// Standalone mock for UnityEngine.MonoBehaviour.
    /// </summary>
    public class MonoBehaviour : Behaviour
    {
    }

    /// <summary>
    /// Standalone mock for UnityEngine.Texture.
    /// </summary>
    public class Texture : Object
    {
        public virtual int width { get; set; }
        public virtual int height { get; set; }
    }

    /// <summary>
    /// Standalone mock for UnityEngine.Texture2D.
    /// </summary>
    public class Texture2D : Texture
    {
        public byte[] RawData { get; private set; } = Array.Empty<byte>();

        public Texture2D(int width, int height)
        {
            this.width = width;
            this.height = height;
        }

        public bool LoadImage(byte[] data)
        {
            RawData = data ?? Array.Empty<byte>();
            return true;
        }
    }
}
#endif
