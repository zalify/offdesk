# Enable one already-uploaded candidate for the existing internal testers.
# Never submit App Store review or enable external/public beta distribution.
require 'base64'
require 'json'
require 'net/http'
require 'openssl'
require 'uri'
$stdout.sync = true

def b64(value)
  Base64.urlsafe_encode64(value, padding: false)
end

def api(method, path, payload = nil, query = {})
  now = Time.now.to_i
  header = b64(JSON.generate(alg: 'ES256', kid: ENV.fetch('APP_STORE_CONNECT_KEY_ID'), typ: 'JWT'))
  claims = b64(JSON.generate(iss: ENV.fetch('APP_STORE_CONNECT_ISSUER_ID'), iat: now, exp: now + 600, aud: 'appstoreconnect-v1'))
  message = "#{header}.#{claims}"
  key = OpenSSL::PKey.read(Base64.decode64(ENV.fetch('APP_STORE_CONNECT_API_KEY')))
  der = key.dsa_sign_asn1(OpenSSL::Digest::SHA256.digest(message))
  signature = OpenSSL::ASN1.decode(der).value.map { |n| [n.value.to_i.to_s(16).rjust(64, '0')].pack('H*') }.join
  uri = URI("https://api.appstoreconnect.apple.com#{path}")
  uri.query = URI.encode_www_form(query) unless query.empty?
  request = Net::HTTP.const_get(method.capitalize).new(uri)
  request['Authorization'] = "Bearer #{message}.#{b64(signature)}"
  request['Content-Type'] = 'application/json'
  request.body = JSON.generate(payload) if payload
  response = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 30, read_timeout: 60) { |http| http.request(request) }
  raise "ASC #{method} #{path}: #{response.code} #{response.body}" unless response.is_a?(Net::HTTPSuccess)
  response.body.to_s.empty? ? {} : JSON.parse(response.body)
end

app = '6807904930'
number = File.read(ARGV.fetch(0)).strip
raise 'Invalid candidate build number' unless number.match?(/\A\d+(?:\.\d+){0,3}\z/)
groups = api('get', '/v1/betaGroups', nil, 'filter[app]' => app)['data']
group = groups.find { |g| g['attributes']['name'] == 'Zalify Team' && g['attributes']['isInternalGroup'] }
raise 'Existing Zalify Team internal group not found' unless group

build = nil
30.times do
  build = api('get', '/v1/builds', nil, 'filter[app]' => app, 'filter[version]' => number)['data'].first
  state = build && build['attributes']['processingState']
  puts "Candidate #{number}: #{state || 'awaiting processing'}"
  break if state == 'VALID'
  raise "Candidate processing failed: #{state}" if %w[FAILED INVALID].include?(state)
  sleep 30
end
raise 'Apple processing still pending; rerun the internal distribution step later' unless build && build['attributes']['processingState'] == 'VALID'

# Reuse the same app's reviewed 0.6.4 declaration. Do not invent a new export
# classification or change the user's existing no-France choice.
previous = api('get', '/v1/builds', nil, 'filter[app]' => app, 'filter[version]' => '0.6.4')['data'].first
raise 'Previous 0.6.4 build not found for encryption declaration' unless previous
declaration = api('get', "/v1/builds/#{previous['id']}/appEncryptionDeclaration")['data']
puts JSON.generate(previousBuild: previous['attributes']['version'], usesNonExemptEncryption: previous['attributes']['usesNonExemptEncryption'], declarationAvailable: !declaration.nil?)
if declaration
  attrs = declaration['attributes']
  raise 'Declaration does not match existing standard-crypto/no-France configuration' unless attrs['containsThirdPartyCryptography'] && !attrs['containsProprietaryCryptography'] && !attrs['availableOnFrenchStore']
  api('patch', "/v1/builds/#{build['id']}", data: {type: 'builds', id: build['id'], relationships: {appEncryptionDeclaration: {data: {type: 'appEncryptionDeclarations', id: declaration['id']}}}})
elsif previous['attributes']['usesNonExemptEncryption'] == false
  # ASC may store the completed questionnaire as an exemption rather than a
  # declaration resource. Reuse that explicit classification, never infer it
  # merely from a missing declaration. This assumes unchanged cryptography.
  unless build['attributes']['usesNonExemptEncryption'] == false
    api('patch', "/v1/builds/#{build['id']}", data: {type: 'builds', id: build['id'], attributes: {usesNonExemptEncryption: false}})
  end
else
  raise 'Previous encryption classification unavailable; complete compliance in App Store Connect'
end
detail = api('get', "/v1/builds/#{build['id']}/buildBetaDetail")['data']['attributes']
puts JSON.generate(internalBuildState: detail['internalBuildState'], hasAccessToAllBuilds: group['attributes']['hasAccessToAllBuilds'])
# Apple's public API rejects assigning builds to internal groups. Existing
# automatic internal distribution can already make this candidate available;
# otherwise an administrator must add it through App Store Connect's UI.
raise 'Add this processed build to the internal group in App Store Connect' unless detail['internalBuildState'] == 'IN_BETA_TESTING'
puts JSON.generate(build: number, internalBuildState: detail['internalBuildState'], externalBuildState: detail['externalBuildState'])
