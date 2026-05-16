using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using JadAppsRunner.Core;
using Xunit;

namespace JadAppsRunner.Core.Tests;

/// <summary>
/// Tests the SettingsClient against an in-process HttpMessageHandler
/// stub so we don't need the real Node sidecar.
/// </summary>
public class SettingsClientTests
{
    [Fact]
    public async Task GetAsync_ReturnsParsedSettings()
    {
        var handler = new StubHandler((req, _ct) =>
        {
            Assert.Equal(HttpMethod.Get, req.Method);
            Assert.Equal("/v1/settings", req.RequestUri!.AbsolutePath);
            Assert.Equal("Bearer test-token", req.Headers.Authorization!.ToString());
            return Task.FromResult(JsonResponse(HttpStatusCode.OK, new
            {
                outputDir = @"C:\Users\alice\Outputs",
                perToolSubfolders = true,
                schemaVersion = 1,
            }));
        });

        var http = new HttpClient(handler);
        var client = new SettingsClient(http, tokenProvider: () => "test-token");
        var s = await client.GetAsync();
        Assert.Equal(@"C:\Users\alice\Outputs", s.OutputDir);
        Assert.True(s.PerToolSubfolders);
        Assert.Equal(1, s.SchemaVersion);
    }

    [Fact]
    public async Task PatchAsync_SendsCamelCasePartial_AndOmitsNulls()
    {
        string? capturedBody = null;
        var handler = new StubHandler(async (req, ct) =>
        {
            Assert.Equal(HttpMethod.Patch, req.Method);
            capturedBody = await req.Content!.ReadAsStringAsync(ct).ConfigureAwait(false);
            return JsonResponse(HttpStatusCode.OK, new
            {
                outputDir = "/tmp/new",
                perToolSubfolders = false,
                schemaVersion = 1,
            });
        });

        var http = new HttpClient(handler);
        var client = new SettingsClient(http, tokenProvider: () => "tok");
        var result = await client.PatchAsync(new SettingsPatch { OutputDir = "/tmp/new" });
        Assert.Equal("/tmp/new", result.OutputDir);
        Assert.NotNull(capturedBody);
        Assert.Contains("\"outputDir\":\"/tmp/new\"", capturedBody);
        Assert.DoesNotContain("perToolSubfolders", capturedBody);
    }

    [Fact]
    public async Task PatchAsync_BothFieldsWhenSet()
    {
        string? capturedBody = null;
        var handler = new StubHandler(async (req, ct) =>
        {
            capturedBody = await req.Content!.ReadAsStringAsync(ct).ConfigureAwait(false);
            return JsonResponse(HttpStatusCode.OK, new
            {
                outputDir = "x",
                perToolSubfolders = true,
                schemaVersion = 1,
            });
        });

        var http = new HttpClient(handler);
        var client = new SettingsClient(http, tokenProvider: () => "tok");
        await client.PatchAsync(new SettingsPatch
        {
            OutputDir = "x",
            PerToolSubfolders = true,
        });
        Assert.NotNull(capturedBody);
        Assert.Contains("\"outputDir\":\"x\"", capturedBody);
        Assert.Contains("\"perToolSubfolders\":true", capturedBody);
    }

    [Fact]
    public async Task PatchAsync_ThrowsOnServerError_IncludingBody()
    {
        var handler = new StubHandler((_req, _ct) => Task.FromResult(
            new HttpResponseMessage(HttpStatusCode.BadRequest)
            {
                Content = new StringContent("{\"error\":\"invalid settings\"}"),
            }));

        var http = new HttpClient(handler);
        var client = new SettingsClient(http, tokenProvider: () => "tok");
        var ex = await Assert.ThrowsAsync<HttpRequestException>(
            () => client.PatchAsync(new SettingsPatch { OutputDir = "x" }));
        Assert.Contains("400", ex.Message);
        Assert.Contains("invalid settings", ex.Message);
    }

    private static HttpResponseMessage JsonResponse(HttpStatusCode status, object body)
    {
        return new HttpResponseMessage(status)
        {
            Content = JsonContent.Create(body, options: new JsonSerializerOptions(JsonSerializerDefaults.Web)),
        };
    }

    private sealed class StubHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> responder)
        : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            return await responder(request, cancellationToken).ConfigureAwait(false);
        }
    }
}
